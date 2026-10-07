import crypto from 'crypto';
import type http from 'http';
import type { AddressInfo } from 'net';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { cancelKey, jobEventsKey } from '../../src/events';
import { startWorkers } from '../../src/workers';

export interface Stack {
  url: string;
  redis: IORedis;
  // Job IDs created through the helpers below, so their keys can be removed afterwards
  jobIds: Set<string>;
  // Resolves once no job is waiting, running or waiting to be retried
  waitForIdle(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

// The API on a free port and, unless disabled, the workers, all on a queue name of their own. Only that
// queue's keys and the tracked jobs' event keys are deleted afterwards, but job IDs on the local queue are
// counters that can repeat another instance's, so point TEST_REDIS_URL at a Redis used only for tests.
export async function startStack({ workers = true } = {}): Promise<Stack> {
  if (!config.redisUrl) {
    throw new Error('Set TEST_REDIS_URL to a Redis used only for tests, e.g. docker run --rm -p 6390:6379 redis:7-alpine');
  }
  config.queueName = `it-${crypto.randomUUID().slice(0, 8)}`;
  config.cloudQueueName = `${config.queueName}-cloud`;

  const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const api = createApp(redis);
  const server: http.Server = api.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.apiUrl = url;
  const running = workers ? startWorkers() : null;
  const jobIds = new Set<string>();
  const queues = [config.queueName, config.cloudQueueName].map((name) => new Queue(name, { connection: redis }));

  return {
    url,
    redis,
    jobIds,
    async waitForIdle(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const counts = await Promise.all(queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'prioritized')));
        if (counts.every((c) => Object.values(c).every((n) => n === 0))) return;
        if (Date.now() > deadline) throw new Error(`Queues still busy: ${JSON.stringify(counts)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async stop() {
      await running?.close();
      server.closeAllConnections();
      server.close();
      await api.close();
      await Promise.all(queues.map((q) => q.close()));
      const keys = [
        ...(await redis.keys(`bull:${config.queueName}*`)),
        ...(await redis.keys(`${config.queueName}*`)),
        ...[...jobIds].flatMap((id) => [jobEventsKey(id), cancelKey(id)])
      ];
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
  };
}

export interface SseEvent {
  event: string;
  id?: string;
  data: any;
}

// Read Server-Sent Events until the stream ends; onEvent can react to each one as it arrives
export async function readEvents(res: Response, onEvent?: (event: SseEvent) => void | Promise<void>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return events;
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(':')) continue; // keep-alive comment
      const fields = Object.fromEntries(block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
      const event: SseEvent = { event: fields.event, data: JSON.parse(fields.data), ...(fields.id ? { id: fields.id } : {}) };
      events.push(event);
      await onEvent?.(event);
    }
  }
}

// Small JSON client for the API that remembers the IDs of the jobs it creates
export function client(stack: Stack) {
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(stack.url + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (json?.jobId) stack.jobIds.add(json.jobId);
    return { status: res.status, body: json };
  };

  return {
    get: (path: string) => request('GET', path),
    post: (path: string, body: unknown) => request('POST', path, body),
    delete: (path: string) => request('DELETE', path),

    // POST /api/stream; returns the events once the job finishes
    async stream(body: unknown, onEvent?: (event: SseEvent) => void | Promise<void>) {
      const res = await fetch(`${stack.url}/api/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) return { status: res.status, body: await res.json(), events: [] };
      const events = await readEvents(res, (event) => {
        if (event.event === 'queued') stack.jobIds.add(event.data.jobId);
        return onEvent?.(event);
      });
      return { status: res.status, body: null, events };
    },

    // GET /api/jobs/:id/stream
    async follow(jobId: string, init: { after?: string; lastEventId?: string } = {}) {
      const query = init.after ? `?after=${init.after}` : '';
      const res = await fetch(`${stack.url}/api/jobs/${jobId}/stream${query}`, {
        headers: init.lastEventId ? { 'Last-Event-ID': init.lastEventId } : {}
      });
      return { status: res.status, events: res.ok ? await readEvents(res) : [], body: res.ok ? null : await res.json() };
    },

    // Poll GET /api/jobs/:id until it completes or fails
    async waitForJob(jobId: string, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { body } = await request('GET', `/api/jobs/${jobId}`);
        if (body?.status === 'completed' || body?.status === 'failed') return body;
        if (Date.now() > deadline) throw new Error(`Job ${jobId} still ${body?.status} after ${timeoutMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  };
}
