import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';
import { searchSimilar } from './db';
import { isClaudeModel, workerHeartbeatKey } from './events';
import { GenerateEvent, InternalError } from './internal-protocol';
import { claudeProvider } from './providers/claude';
import { ollamaProvider } from './providers/ollama';
import { Provider } from './providers/types';

// The worker is considered offline if no heartbeat arrives within this window
const HEARTBEAT_TTL_SEC = 60;

const providerFor = (model: string): Provider => (isClaudeModel(model) ? claudeProvider : ollamaProvider);

// Retrying can't fix refusals, bad requests or credential problems; everything else may be transient
const isPermanent = (error: unknown) => error instanceof UnrecoverableError;

function sendError(res: Response, status: number, error: string, permanent: boolean) {
  const body: InternalError = { error, permanent };
  res.status(status).json(body);
}

// Only the worker holds the token; without one configured the internal API stays closed
function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!config.internalToken) {
    sendError(res, 503, 'Internal API disabled: INTERNAL_API_TOKEN is not set on the backend.', false);
    return;
  }
  const given = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(config.internalToken);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    sendError(res, 401, 'Invalid internal API token.', true);
    return;
  }
  next();
}

// Abort the model call if the worker disconnects before the response finishes, so no GPU time or credits are wasted
function abortOnDisconnect(res: Response) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

export function createInternalRouter(redis: IORedis): Router {
  const router = Router();
  router.use(requireToken);

  // Stream generated tokens back as newline-delimited JSON
  router.post('/generate', async (req: Request, res: Response): Promise<void> => {
    const { prompt } = req.body;
    const model: string = req.body.model ?? config.llmModel;
    if (typeof prompt !== 'string' || typeof model !== 'string') {
      sendError(res, 400, 'prompt and model must be strings.', true);
      return;
    }

    const signal = abortOnDisconnect(res);
    const write = (event: GenerateEvent) => res.write(JSON.stringify(event) + '\n');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });

    try {
      const result = await providerFor(model).streamText(model, prompt, async (token) => {
        write({ type: 'token', token });
      }, signal);
      write({ type: 'done', ...result });
    } catch (error: any) {
      if (signal.aborted) return; // the worker is gone; nobody to report to
      console.error(`[internal] Generation with ${model} failed:`, error.message);
      write({ type: 'error', message: error.message, permanent: isPermanent(error) });
    }
    res.end();
  });

  router.post('/analyze', async (req: Request, res: Response): Promise<void> => {
    const { text } = req.body;
    const model: string = req.body.model ?? config.llmModel;
    if (typeof text !== 'string' || typeof model !== 'string') {
      sendError(res, 400, 'text and model must be strings.', true);
      return;
    }

    const signal = abortOnDisconnect(res);
    try {
      res.json(await providerFor(model).analyze(model, text, signal));
    } catch (error: any) {
      if (signal.aborted) return;
      console.error(`[internal] Analysis with ${model} failed:`, error.message);
      sendError(res, isPermanent(error) ? 422 : 502, error.message, isPermanent(error));
    }
  });

  // Knowledge base lookup for grounding answers
  router.post('/search', async (req: Request, res: Response): Promise<void> => {
    const { query, limit } = req.body;
    if (typeof query !== 'string') {
      sendError(res, 400, 'query must be a string.', true);
      return;
    }
    try {
      res.json({ docs: await searchSimilar(query, typeof limit === 'number' ? limit : undefined) });
    } catch (error: any) {
      console.error('[internal] Search failed:', error.message);
      sendError(res, 502, `Knowledge base search failed: ${error.message}`, false);
    }
  });

  router.put('/heartbeat', async (_req: Request, res: Response): Promise<void> => {
    try {
      await redis.set(workerHeartbeatKey(config.queueName), new Date().toISOString(), 'EX', HEARTBEAT_TTL_SEC);
      res.status(204).end();
    } catch (error: any) {
      sendError(res, 502, `Failed to record heartbeat: ${error.message}`, false);
    }
  });

  // Sent on graceful shutdown so the UI shows the worker offline immediately
  router.delete('/heartbeat', async (_req: Request, res: Response): Promise<void> => {
    try {
      await redis.del(workerHeartbeatKey(config.queueName));
      res.status(204).end();
    } catch (error: any) {
      sendError(res, 502, `Failed to clear heartbeat: ${error.message}`, false);
    }
  });

  return router;
}
