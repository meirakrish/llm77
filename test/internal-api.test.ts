import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { UnrecoverableError } from 'bullmq';
import type IORedis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/providers/ollama', () => ({ ollamaProvider: { streamText: vi.fn(), analyze: vi.fn() } }));
vi.mock('../src/db', () => ({ searchRelevant: vi.fn() }));

import { config } from '../src/config';
import { searchRelevant } from '../src/db';
import * as backend from '../src/internal-client';
import { createInternalRouter } from '../src/internal-api';
import { ollamaProvider } from '../src/providers/ollama';
import type { Provider } from '../src/providers/types';

const ollama = vi.mocked(ollamaProvider);
const search = vi.mocked(searchRelevant);

const usage = { promptTokens: 3, completionTokens: 2, tokensPerSecond: 10 };
const analysis = { summary: 's', category: 'Support' as const, urgency: 'Low' as const, actionItems: [] };
const question = [{ role: 'user' as const, content: 'hi' }];

// Emits the given tokens, then finishes
const streamsTokens = (...tokens: string[]): Provider['streamText'] => async (model, _messages, onToken) => {
  for (const token of tokens) await onToken(token);
  return { text: tokens.join(''), model, usage };
};

const redis = { set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) };
let server: http.Server;
let baseUrl: string;

async function listen(app: express.Express) {
  const s = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => s.once('listening', resolve));
  return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/internal', createInternalRouter(redis as unknown as IORedis));
  ({ server, url: baseUrl } = await listen(app));
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  config.apiUrl = baseUrl;
  config.internalToken = 'test-token';
});

describe('authentication', () => {
  it('rejects a wrong token as a permanent failure', async () => {
    const res = await fetch(`${baseUrl}/internal/heartbeat`, { method: 'PUT', headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid internal API token.', permanent: true });
  });

  it('rejects a request without a token', async () => {
    const res = await fetch(`${baseUrl}/internal/heartbeat`, { method: 'PUT' });
    expect(res.status).toBe(401);
  });

  it('stays closed when no token is configured', async () => {
    config.internalToken = '';
    const error = await backend.heartbeat(true).catch((e) => e);
    expect(error.message).toContain('INTERNAL_API_TOKEN is not set');
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });
});

describe('generate', () => {
  it('streams tokens to the worker and returns the result', async () => {
    ollama.streamText.mockImplementation(streamsTokens('Hel', 'lo', '\n', ' world'));
    const tokens: string[] = [];
    const result = await backend.generate('qwen', question, async (t) => void tokens.push(t));

    expect(tokens).toEqual(['Hel', 'lo', '\n', ' world']);
    expect(result).toEqual({ text: 'Hello\n world', model: 'qwen', usage });
    expect(ollama.streamText).toHaveBeenCalledWith('qwen', question, expect.any(Function), expect.any(AbortSignal));
  });

  it('reports permanent provider failures as unrecoverable', async () => {
    ollama.streamText.mockRejectedValue(new UnrecoverableError('Data extraction layout violation: bad JSON'));
    const error = await backend.generate('qwen', question, async () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('Data extraction layout violation: bad JSON');
  });

  it('reports other failures as retryable, after the tokens already sent', async () => {
    ollama.streamText.mockImplementation(async (_m, _msgs, onToken) => {
      await onToken('partial');
      throw new Error('Ollama crashed');
    });
    const tokens: string[] = [];
    const error = await backend.generate('qwen', question, async (t) => void tokens.push(t)).catch((e) => e);
    expect(tokens).toEqual(['partial']);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('Ollama crashed');
  });

  it('rejects an invalid conversation without calling a model', async () => {
    const error = await backend.generate('qwen', [{ role: 'assistant', content: 'hi' }], async () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toContain('Message 1 must have role "user"');
    expect(ollama.streamText).not.toHaveBeenCalled();
  });

  it('stops the model call when the worker aborts', async () => {
    let providerSignal: AbortSignal | undefined;
    ollama.streamText.mockImplementation(async (model, _messages, onToken, signal) => {
      providerSignal = signal;
      await onToken('first');
      await new Promise((resolve) => signal!.addEventListener('abort', resolve));
      throw new Error('aborted');
    });
    const controller = new AbortController();
    const result = backend.generate('qwen', question, async () => controller.abort(), controller.signal);

    await expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
  });
});

describe('analyze', () => {
  it('returns the structured analysis', async () => {
    ollama.analyze.mockResolvedValue({ data: analysis, model: 'qwen', usage });
    expect(await backend.analyze('qwen', 'my order is late')).toEqual({ data: analysis, model: 'qwen', usage });
    expect(ollama.analyze).toHaveBeenCalledWith('qwen', 'my order is late', expect.any(AbortSignal));
  });

  it('keeps the permanent flag of failures', async () => {
    ollama.analyze.mockRejectedValueOnce(new UnrecoverableError('layout violation'));
    await expect(backend.analyze('qwen', 'x')).rejects.toBeInstanceOf(UnrecoverableError);

    ollama.analyze.mockRejectedValueOnce(new Error('timeout'));
    const error = await backend.analyze('qwen', 'x').catch((e) => e);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('timeout');
  });
});

describe('search', () => {
  it('returns the relevant chunks', async () => {
    const docs = [{ docId: 'd1', source: 'a.md', chunkIndex: 0, text: 'Alpha', distance: 0.2 }];
    search.mockResolvedValue(docs);
    expect(await backend.search('alpha?')).toEqual(docs);
    expect(search).toHaveBeenCalledWith('alpha?', undefined);
  });

  it('reports knowledge base failures as retryable', async () => {
    search.mockRejectedValue(new Error('embedding model missing'));
    const error = await backend.search('alpha?').catch((e) => e);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('Knowledge base search failed: embedding model missing');
  });
});

describe('heartbeat', () => {
  it('marks the worker online for a minute', async () => {
    await backend.heartbeat(true);
    expect(redis.set).toHaveBeenCalledWith('test-queue:worker-heartbeat', expect.any(String), 'EX', 60);
  });

  it('marks the worker offline on shutdown', async () => {
    await backend.heartbeat(false);
    expect(redis.del).toHaveBeenCalledWith('test-queue:worker-heartbeat');
  });
});

describe('client connection problems', () => {
  it('reports an unreachable backend as retryable', async () => {
    const { server: s, url } = await listen(express());
    s.close();
    config.apiUrl = url;
    const error = await backend.heartbeat(true).catch((e) => e);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe(`Backend unreachable at ${url}: ECONNREFUSED`);
  });

  it('fails a generation the backend ends early', async () => {
    const app = express();
    app.post('/internal/generate', (_req, res) => {
      res.write(JSON.stringify({ type: 'token', token: 'half' }) + '\n');
      res.end();
    });
    const { server: s, url } = await listen(app);
    config.apiUrl = url;
    const tokens: string[] = [];
    try {
      await expect(backend.generate('qwen', question, async (t) => void tokens.push(t))).rejects.toThrow(
        'Connection to the backend closed before generation finished.'
      );
      expect(tokens).toEqual(['half']);
    } finally {
      s.close();
    }
  });
});
