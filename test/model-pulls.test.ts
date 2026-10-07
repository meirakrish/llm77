import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ollama-client', () => ({ ollama: { pull: vi.fn(), show: vi.fn() } }));
vi.mock('../src/model-info', () => ({ invalidateModelsInfo: vi.fn() }));

import { ollama } from '../src/ollama-client';
import { invalidateModelsInfo } from '../src/model-info';
import { cancelPull, isValidModelName, listPulls, startPull } from '../src/model-pulls';

const pull = vi.mocked(ollama.pull) as unknown as ReturnType<typeof vi.fn>;
const show = vi.mocked(ollama.show) as unknown as ReturnType<typeof vi.fn>;

// An Ollama pull progress stream that yields the given parts, then waits for release() (or abort) before ending
function progressStream(parts: object[]) {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const ended = new Promise<void>((resolve, reject) => ((release = resolve), (fail = reject)));
  const stream = Object.assign((async function* () {
    yield* parts;
    await ended;
  })(), { abort: vi.fn(() => fail(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))) });
  return { stream, release };
}

const pullOf = (model: string) => listPulls().find((p) => p.model === model);

beforeEach(() => vi.clearAllMocks());

describe('isValidModelName', () => {
  it.each(['llama3.2:1b', 'qwen2.5', 'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M', 'library/mistral:latest'])('accepts %s', (name) => {
    expect(isValidModelName(name)).toBe(true);
  });

  it.each(['', ' llama', 'llama 3', '-rf', '../etc', 'a?b', 'x'.repeat(201)])('rejects %j', (name) => {
    expect(isValidModelName(name)).toBe(false);
  });
});

describe('model pulls', () => {
  it('reports progress summed over layers, then whether the model can generate', async () => {
    const { stream, release } = progressStream([
      { status: 'pulling manifest' },
      { status: 'pulling aaa', digest: 'aaa', total: 1000, completed: 250 },
      { status: 'pulling bbb', digest: 'bbb', total: 200, completed: 200 }
    ]);
    pull.mockResolvedValue(stream);
    show.mockResolvedValue({ capabilities: ['completion'] });

    expect(startPull('tiny:1b')).toMatchObject({ model: 'tiny:1b', status: 'pulling' });
    await vi.waitFor(() => expect(pullOf('tiny:1b')).toMatchObject({ detail: 'pulling bbb', completedBytes: 450, totalBytes: 1200 }));
    expect(pull).toHaveBeenCalledWith({ model: 'tiny:1b', stream: true });

    release();
    await vi.waitFor(() => expect(pullOf('tiny:1b')).toMatchObject({ status: 'done', canGenerate: true, finishedAt: expect.any(String) }));
    expect(invalidateModelsInfo).toHaveBeenCalled();
  });

  it('returns the running pull instead of starting the same one twice', async () => {
    const { stream, release } = progressStream([]);
    pull.mockResolvedValue(stream);
    show.mockResolvedValue({ capabilities: ['embedding'] });

    const first = startPull('embed');
    expect(startPull('embed').startedAt).toBe(first.startedAt);
    expect(pull).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(pullOf('embed')).toMatchObject({ status: 'done', canGenerate: false }));
  });

  it('cancels a running pull', async () => {
    const { stream } = progressStream([{ status: 'pulling manifest' }]);
    pull.mockResolvedValue(stream);

    startPull('big:70b');
    await vi.waitFor(() => expect(pullOf('big:70b')?.detail).toBe('pulling manifest'));
    expect(cancelPull('big:70b')).toBe(true);
    expect(stream.abort).toHaveBeenCalled();
    await vi.waitFor(() => expect(pullOf('big:70b')).toMatchObject({ status: 'cancelled', finishedAt: expect.any(String) }));
    expect(pullOf('big:70b')?.error).toBeUndefined();
    expect(cancelPull('big:70b')).toBe(false);
    expect(cancelPull('never-started')).toBe(false);
  });

  it('reports a failed pull', async () => {
    pull.mockRejectedValue(new Error('pull model manifest: file does not exist'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    startPull('nope:1b');
    await vi.waitFor(() => expect(pullOf('nope:1b')).toMatchObject({ status: 'error', error: 'pull model manifest: file does not exist' }));
    expect(invalidateModelsInfo).not.toHaveBeenCalled();
  });
});
