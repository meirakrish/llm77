import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { claudeProvider } from '../../src/providers/claude';
import { ollamaProvider } from '../../src/providers/ollama';
import { gate, usage } from './fixtures';
import { client, startStack, type Stack } from './stack';

let stack: Stack;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  stack = await startStack();
  api = client(stack);
});
afterAll(() => stack?.stop());

describe('usage stats', () => {
  it('records every finished job once, by outcome and model', async () => {
    // Two completed local jobs
    await api.stream({ prompt: 'one' });
    await api.waitForJob((await api.post('/api/jobs', { prompt: 'two', model: 'qwen' })).body.jobId);

    // A Claude job that fails permanently, with its cost not counted
    vi.mocked(claudeProvider.streamText).mockRejectedValueOnce(new UnrecoverableError('Claude declined this request.'));
    await api.waitForJob((await api.post('/api/jobs', { prompt: 'three', model: 'claude-haiku-4-5' })).body.jobId);

    // A completed Claude job with a cost
    vi.mocked(claudeProvider.streamText).mockResolvedValueOnce({ text: 'ok', model: 'claude-haiku-4-5', usage: { ...usage, costUsd: 0.0012 } });
    await api.waitForJob((await api.post('/api/jobs', { prompt: 'four', model: 'claude-haiku-4-5' })).body.jobId);

    // A job cancelled while waiting behind a running one, which is recorded by the API rather than a worker
    const running = gate();
    vi.mocked(ollamaProvider.streamText).mockImplementationOnce(async (model) => {
      await running.opened;
      return { text: 'slow', model, usage };
    });
    const slow = (await api.post('/api/jobs', { prompt: 'slow' })).body.jobId;
    await vi.waitFor(() => expect(ollamaProvider.streamText).toHaveBeenCalledTimes(3));
    const waiting = (await api.post('/api/jobs', { prompt: 'waiting' })).body.jobId;
    expect((await api.delete(`/api/jobs/${waiting}`)).status).toBe(204);
    running.open();
    await api.waitForJob(slow);

    const { status, body } = await api.get('/api/stats?range=24h');
    expect(status).toBe(200);
    expect(body.totals).toMatchObject({ jobs: 6, completed: 4, failed: 1, cancelled: 1, promptTokens: 28, completionTokens: 8, costUsd: 0.0012 });
    expect(body.models).toEqual([
      expect.objectContaining({ model: 'test-llm', provider: 'ollama', jobs: 3, completed: 2, cancelled: 1, medianTokensPerSecond: 40 }),
      expect.objectContaining({ model: 'claude-haiku-4-5', provider: 'claude', jobs: 2, completed: 1, failed: 1, costUsd: 0.0012 }),
      expect.objectContaining({ model: 'qwen', provider: 'ollama', jobs: 1, completed: 1 })
    ]);
    expect(body.timeline.reduce((total: number, bucket: { jobs: number }) => total + bucket.jobs, 0)).toBe(6);
  });

  it('rejects an unknown range', async () => {
    expect(await api.get('/api/stats?range=1y')).toEqual({ status: 400, body: { error: 'range must be one of: 24h, 7d, 30d.' } });
  });
});
