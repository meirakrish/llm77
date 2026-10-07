import { UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ollama-client', () => ({ ollama: { chat: vi.fn(), generate: vi.fn() } }));

import { ollama } from '../src/ollama-client';
import { contextFor, ollamaProvider } from '../src/providers/ollama';

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

// A streamed generate response: the output in two parts, the last carrying the statistics
function generateStream(output: string, doneReason = 'stop') {
  const half = Math.floor(output.length / 2);
  const parts = [
    { response: output.slice(0, half), done: false },
    { response: output.slice(half), done: true, done_reason: doneReason, ...stats }
  ];
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

  it('sends images, inlines documents and widens the context for long prompts', async () => {
    chat.mockResolvedValue(chatStream(['ok']));
    const text = 'x'.repeat(30_000);
    await ollamaProvider.streamText('seer', [{ role: 'user', content: 'Compare', images: ['aGVsbG8='], documents: [{ name: 'a.txt', text }] }], async () => {});

    const request = chat.mock.calls[0][0];
    expect(request.messages).toEqual([{ role: 'user', content: expect.stringContaining(`<file>\n${text}\n</file>\n\nCompare`), images: ['aGVsbG8='] }]);
    expect(request.options).toEqual({ num_ctx: 11264 });
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
    generate.mockResolvedValue(generateStream(JSON.stringify(valid)));
    const result = await ollamaProvider.analyze('qwen', 'Where is my order?');
    expect(result).toEqual({ data: valid, model: 'qwen', usage: { promptTokens: 12, completionTokens: 50, tokensPerSecond: 25 } });

    const request = generate.mock.calls[0][0];
    expect(request).toMatchObject({ model: 'qwen', stream: true, options: { temperature: 0, num_predict: 1024 } });
    expect(request.format).toMatchObject({ type: 'object', required: expect.arrayContaining(['summary', 'category']) });
    expect(request.prompt).toContain('Where is my order?');
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['a value outside the schema', JSON.stringify({ ...valid, category: 'Other' })],
    ['a missing field', JSON.stringify({ summary: 'x', category: 'Spam', urgency: 'Low' })],
    ['too many action items', JSON.stringify({ ...valid, actionItems: ['a', 'b', 'c', 'd', 'e', 'f'] })]
  ])('treats %s as a permanent failure', async (_name, response) => {
    generate.mockResolvedValue(generateStream(response));
    const error = await ollamaProvider.analyze('qwen', 'x').catch((e) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toMatch(/^Data extraction layout violation/);
  });

  it('bounds the output in the schema handed to Ollama', async () => {
    generate.mockResolvedValue(generateStream(JSON.stringify(valid)));
    await ollamaProvider.analyze('qwen', 'x');
    const { properties } = generate.mock.calls[0][0].format;
    expect(properties.summary.maxLength).toBe(300);
    expect(properties.actionItems).toMatchObject({ maxItems: 5, items: { maxLength: 200 } });
  });

  it('fails permanently when the model hits the token limit', async () => {
    generate.mockResolvedValue(generateStream('{"summary": "check the air filter, check the air filter, ', 'length'));
    const error = await ollamaProvider.analyze('qwen', 'x').catch((e) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('Data extraction layout violation: the model produced 1024 tokens without finishing.');
  });

  it('stops generating when aborted', async () => {
    const stream = generateStream(JSON.stringify(valid));
    generate.mockResolvedValue(stream);
    const controller = new AbortController();
    const pending = ollamaProvider.analyze('qwen', 'x', controller.signal);
    controller.abort();
    await pending.catch(() => {});
    expect(stream.abort).toHaveBeenCalled();
  });
});

describe('contextFor', () => {
  const ask = (chars: number) => [{ role: 'user' as const, content: 'x'.repeat(chars) }];

  it("keeps Ollama's default for short prompts", () => {
    expect(contextFor(ask(9000))).toBeUndefined();
  });

  it('rounds up to fit longer prompts, up to the configured maximum', () => {
    expect(contextFor(ask(12_000))).toBe(5120);
    expect(contextFor(ask(1_000_000))).toBe(16384);
  });
});
