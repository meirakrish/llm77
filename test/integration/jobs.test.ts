import { UnrecoverableError } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { searchRelevant } from '../../src/db';
import { jobEventsKey } from '../../src/events';
import { claudeProvider } from '../../src/providers/claude';
import { ollamaProvider } from '../../src/providers/ollama';
import { gate, modelsInfo, streamsTokens, usage } from './fixtures';
import { client, startStack, type Stack } from './stack';

let stack: Stack;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  stack = await startStack();
  api = client(stack);
});
afterAll(() => stack?.stop());
// A job still running or retrying would otherwise run into the next test's mocks
afterEach(() => stack.waitForIdle());

const ollama = vi.mocked(ollamaProvider);
const claude = vi.mocked(claudeProvider);

describe('service status', () => {
  it('reports the API healthy', async () => {
    expect(await api.get('/api/health')).toEqual({ status: 200, body: { ok: true } });
  });

  it('shows the worker online once its heartbeat arrives', async () => {
    await vi.waitFor(async () => expect((await api.get('/api/info')).body).toMatchObject({ workerOnline: true, ...modelsInfo }));
  });

  it('lists local and enabled Claude models', async () => {
    const { body } = await api.get('/api/models');
    expect(body.defaultModel).toBe('test-llm');
    expect(body.models).toEqual([
      { id: 'test-llm', name: 'test-llm', provider: 'ollama' },
      { id: 'qwen', name: 'qwen', provider: 'ollama' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', inputPrice: 1, outputPrice: 5, provider: 'claude' }
    ]);
  });
});

describe('streaming', () => {
  it('streams tokens and the result of a generation', async () => {
    const { status, events } = await api.stream({ prompt: 'Say hello' });
    expect(status).toBe(200);
    expect(events[0]).toEqual({ event: 'queued', data: { jobId: expect.any(String) } });

    const rest = events.filter((e) => e.event !== 'queued' && e.event !== 'position');
    expect(rest.map((e) => e.event)).toEqual(['token', 'token', 'done']);
    expect(rest.map((e) => e.data.token)).toEqual(['Hello', ' world', undefined]);
    for (const event of rest) expect(event.id).toMatch(/^\d+-\d+$/);
    expect(rest[2].data).toEqual({
      text: 'Hello world',
      model: 'test-llm',
      sources: [],
      metrics: expect.objectContaining({ promptTokens: 7, completionTokens: 2, totalTokens: 9, tokensPerSecond: 40 })
    });
    expect(ollama.streamText).toHaveBeenCalledWith('test-llm', [{ role: 'user', content: 'Say hello' }], expect.any(Function), expect.any(AbortSignal));
  });

  it('grounds the question in relevant knowledge base chunks and returns them as sources', async () => {
    const chunk = { docId: 'd1', source: 'guide.md', chunkIndex: 0, text: 'LanceDB is embedded.', distance: 0.2 };
    vi.mocked(searchRelevant).mockResolvedValue([chunk]);
    const { events } = await api.stream({ messages: [{ role: 'user', content: 'What is LanceDB?' }, { role: 'assistant', content: 'A database.' }, { role: 'user', content: 'Is it embedded?' }] });

    expect(searchRelevant).toHaveBeenCalledWith('What is LanceDB?\nIs it embedded?', undefined);
    const sent = ollama.streamText.mock.calls[0][1];
    expect(sent.slice(0, 2)).toEqual([{ role: 'user', content: 'What is LanceDB?' }, { role: 'assistant', content: 'A database.' }]);
    expect(sent[2].content).toContain('[1] (from "guide.md") LanceDB is embedded.');
    expect(events.at(-1)!.data.sources).toEqual([chunk]);
  });

  it('runs Claude models on the cloud queue', async () => {
    const { events } = await api.stream({ prompt: 'hi', model: 'claude-haiku-4-5' });
    expect(events[0].data.jobId).toMatch(/^cloud-/);
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { text: 'Hi from Claude', model: 'claude-haiku-4-5' } });
    expect(ollama.streamText).not.toHaveBeenCalled();
  });

  it('reports a failure as an error event without retrying', async () => {
    ollama.streamText.mockRejectedValue(new Error('Ollama is restarting'));
    const { events } = await api.stream({ prompt: 'hi' });
    expect(events.at(-1)).toEqual({ event: 'error', id: expect.any(String), data: { message: 'Ollama is restarting', cancelled: false } });
    const job = await api.waitForJob(events[0].data.jobId);
    expect(job).toMatchObject({ status: 'failed', failedReason: 'Ollama is restarting' });
    expect(ollama.streamText).toHaveBeenCalledTimes(1);
  });
});

describe('following a job', () => {
  let jobId: string;
  let tokenIds: string[];

  beforeAll(async () => {
    // Runs before the per-test mock reset in setup.ts
    ollama.streamText.mockImplementation(streamsTokens('Hello', ' world'));
    const { events } = await api.stream({ prompt: 'Say hello' });
    jobId = events[0].data.jobId;
    tokenIds = events.filter((e) => e.id).map((e) => e.id!);
  });

  it('replays all events of a finished job', async () => {
    const { events } = await api.follow(jobId);
    expect(events.map((e) => e.event)).toEqual(['position', 'token', 'token', 'done']);
    expect(events.filter((e) => e.id).map((e) => e.id)).toEqual(tokenIds);
  });

  it('resumes after a given event, from ?after= or Last-Event-ID', async () => {
    for (const init of [{ after: tokenIds[0] }, { lastEventId: tokenIds[0] }]) {
      const { events } = await api.follow(jobId, init);
      expect(events.filter((e) => e.event !== 'position').map((e) => e.data.token ?? e.event)).toEqual([' world', 'done']);
    }
  });

  it('ends with the stored result once the job\'s events have expired', async () => {
    await stack.redis.del(jobEventsKey(jobId));
    const { events } = await api.follow(jobId);
    expect(events.at(-1)).toEqual({ event: 'done', data: expect.objectContaining({ text: 'Hello world', model: 'test-llm' }) });
  });

  it('rejects bad requests', async () => {
    expect((await api.follow(jobId, { after: 'abc' })).status).toBe(400);
    expect((await api.follow('no-such-job')).status).toBe(404);
    ollama.analyze.mockResolvedValue({ data: { summary: 's', category: 'Spam', urgency: 'Low', actionItems: [] }, model: 'test-llm', usage });
    const { body } = await api.post('/api/analyze', { text: 'x' });
    expect((await api.follow(body.jobId)).status).toBe(400);
  });
});

describe('queued jobs', () => {
  it('runs a generation and returns its result when polled', async () => {
    const { status, body } = await api.post('/api/jobs', { prompt: 'Say hello', model: 'qwen' });
    expect(status).toBe(202);
    expect(await api.waitForJob(body.jobId)).toMatchObject({
      status: 'completed',
      data: 'Hello world',
      model: 'qwen',
      sources: [],
      failedReason: null,
      metrics: expect.objectContaining({ completionTokens: 2 })
    });
  });

  it('runs an analysis', async () => {
    const data = { summary: 'Late order', category: 'Support', urgency: 'High', actionItems: ['Check shipping'] };
    ollama.analyze.mockResolvedValue({ data, model: 'test-llm', usage } as any);
    const { body } = await api.post('/api/analyze', { text: 'Where is my order?' });
    expect(await api.waitForJob(body.jobId)).toMatchObject({ status: 'completed', data, model: 'test-llm' });
    expect(ollama.analyze).toHaveBeenCalledWith('test-llm', 'Where is my order?', expect.any(AbortSignal));
  });

  it('retries a transient failure', async () => {
    ollama.streamText.mockRejectedValueOnce(new Error('Ollama is restarting'));
    const { body } = await api.post('/api/jobs', { prompt: 'hi' });
    // The first retry waits for the 2s backoff
    expect(await api.waitForJob(body.jobId)).toMatchObject({ status: 'completed', data: 'Hello world' });
    expect(ollama.streamText).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent failure', async () => {
    claude.streamText.mockRejectedValue(new UnrecoverableError('Claude declined this request.'));
    const { body } = await api.post('/api/jobs', { prompt: 'hi', model: 'claude-haiku-4-5' });
    expect(await api.waitForJob(body.jobId)).toMatchObject({ status: 'failed', failedReason: 'Claude declined this request.' });
    expect(claude.streamText).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, 'A text prompt (or a messages array) is required.'],
    [{ messages: [{ role: 'assistant', content: 'hi' }] }, 'Message 1 must have role "user": turns alternate, starting with the user.'],
    [{ prompt: 'hi', model: 42 }, 'model must be a string.'],
    [{ prompt: 'hi', model: 'llama9' }, 'Model llama9 is not installed in Ollama.'],
    [{ prompt: 'hi', model: 'claude-unknown' }, 'Model claude-unknown is not enabled.'],
    [{ prompt: 'hi', model: 'claude-opus-5-5' }, 'Model claude-opus-5-5 is not available: not accessible with the configured credentials']
  ])('rejects %j', async (request, error) => {
    expect(await api.post('/api/jobs', request)).toEqual({ status: 400, body: { error } });
    expect((await api.stream(request)).body).toEqual({ error });
  });

  it('returns 404 for an unknown job', async () => {
    expect((await api.get('/api/jobs/12345678')).status).toBe(404);
    expect((await api.get('/api/jobs/cloud-nope')).status).toBe(404);
  });
});

describe('cancelling', () => {
  it('stops a running generation', async () => {
    let providerSignal: AbortSignal | undefined;
    ollama.streamText.mockImplementation(async (_model, _messages, onToken, signal) => {
      providerSignal = signal;
      await onToken('partial');
      await new Promise((resolve) => signal!.addEventListener('abort', resolve));
      throw new Error('aborted');
    });

    let jobId = '';
    const { events } = await api.stream({ prompt: 'Write a long story' }, async (event) => {
      if (event.event === 'queued') jobId = event.data.jobId;
      if (event.event === 'token') {
        expect(await api.delete(`/api/jobs/${jobId}`)).toEqual({ status: 202, body: { message: 'Cancelling: the worker will stop the job.' } });
      }
    });

    expect(events.at(-1)).toMatchObject({ event: 'error', data: { message: 'Cancelled by user.', cancelled: true } });
    expect(providerSignal?.aborted).toBe(true);
    expect(await api.waitForJob(jobId)).toMatchObject({ status: 'failed', failedReason: 'Cancelled by user.' });
  });

  it('removes a job still waiting in the queue', async () => {
    const running = gate();
    ollama.streamText.mockImplementationOnce(async (model, _messages, onToken) => {
      await running.opened;
      await onToken('done');
      return { text: 'done', model, usage };
    });
    const first = (await api.post('/api/jobs', { prompt: 'first' })).body.jobId;
    await vi.waitFor(() => expect(ollama.streamText).toHaveBeenCalledTimes(1));

    const second = (await api.post('/api/jobs', { prompt: 'second' })).body.jobId;
    expect((await api.get(`/api/jobs/${second}`)).body).toMatchObject({ status: 'waiting', ahead: 1 });

    expect((await api.delete(`/api/jobs/${second}`)).status).toBe(204);
    expect((await api.get(`/api/jobs/${second}`)).status).toBe(404);

    running.open();
    expect(await api.waitForJob(first)).toMatchObject({ status: 'completed', data: 'done' });
    expect(ollama.streamText).toHaveBeenCalledTimes(1);
  });

  it('refuses to cancel a finished job', async () => {
    const { body } = await api.post('/api/jobs', { prompt: 'hi' });
    await api.waitForJob(body.jobId);
    expect(await api.delete(`/api/jobs/${body.jobId}`)).toEqual({ status: 409, body: { error: 'The job has already finished.' } });
    expect((await api.delete('/api/jobs/12345678')).status).toBe(404);
  });
});
