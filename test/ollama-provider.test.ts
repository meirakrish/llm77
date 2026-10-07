import { UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ollama-client', () => ({ ollama: { chat: vi.fn(), generate: vi.fn() } }));

import { ollama } from '../src/ollama-client';
import { ollamaProvider } from '../src/providers/ollama';

const chat = vi.mocked(ollama.chat) as unknown as ReturnType<typeof vi.fn>;
const generate = vi.mocked(ollama.generate) as unknown as ReturnType<typeof vi.fn>;

const stats = { prompt_eval_count: 12, eval_count: 50, eval_duration: 2_000_000_000 };

// An Ollama streaming response: an async iterable of parts that can be aborted
function chatStream(tokens: string[]) {
  const parts = tokens.map((content, i) => ({
    message: { role: 'assistant', content },
    done: i === tokens.length - 1,
    ...(i === tokens.length - 1 ? stats : {})
  }));
  return Object.assign((async function* () { yield* parts; })(), { abort: vi.fn() });
}

beforeEach(() => vi.clearAllMocks());

describe('ollamaProvider.streamText', () => {
  it('forwards non-empty tokens and reports usage from the final part', async () => {
    chat.mockResolvedValue(chatStream(['Hi', '', ' there', '']));
    const tokens: string[] = [];
    const result = await ollamaProvider.streamText('qwen', [{ role: 'user', content: 'hello' }], async (t) => void tokens.push(t));

    expect(tokens).toEqual(['Hi', ' there']);
    expect(result).toEqual({ text: 'Hi there', model: 'qwen', usage: { promptTokens: 12, completionTokens: 50, tokensPerSecond: 25 } });
    expect(chat).toHaveBeenCalledWith({ model: 'qwen', messages: [{ role: 'user', content: 'hello' }], stream: true });
  });

  it('aborts the Ollama request when the signal fires', async () => {
    const stream = chatStream(['a']);
    chat.mockResolvedValue(stream);
    const controller = new AbortController();
    await ollamaProvider.streamText('qwen', [{ role: 'user', content: 'x' }], async () => controller.abort(), controller.signal);
    expect(stream.abort).toHaveBeenCalled();
  });
});

describe('ollamaProvider.analyze', () => {
  const valid = { summary: 'Late order', category: 'Support', urgency: 'High', actionItems: ['Check shipping'] };

  it('returns output that matches the schema', async () => {
    generate.mockResolvedValue({ response: JSON.stringify(valid), ...stats });
    const result = await ollamaProvider.analyze('qwen', 'Where is my order?');
    expect(result).toEqual({ data: valid, model: 'qwen', usage: { promptTokens: 12, completionTokens: 50, tokensPerSecond: 25 } });

    const request = generate.mock.calls[0][0];
    expect(request).toMatchObject({ model: 'qwen', stream: false, options: { temperature: 0 } });
    expect(request.format).toMatchObject({ type: 'object', required: expect.arrayContaining(['summary', 'category']) });
    expect(request.prompt).toContain('Where is my order?');
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['a value outside the schema', JSON.stringify({ ...valid, category: 'Other' })],
    ['a missing field', JSON.stringify({ summary: 'x', category: 'Spam', urgency: 'Low' })]
  ])('treats %s as a permanent failure', async (_name, response) => {
    generate.mockResolvedValue({ response, ...stats });
    const error = await ollamaProvider.analyze('qwen', 'x').catch((e) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toMatch(/^Data extraction layout violation/);
  });
});
