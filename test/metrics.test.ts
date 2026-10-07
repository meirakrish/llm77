import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { getStats, kindOf, recordJob, recordJobSafely, type JobRecord } from '../src/metrics';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 7, 12, 30);

// Just the Redis Stream commands metrics.ts uses, with IDs stamped from the (faked) clock
function fakeRedis() {
  const entries: [string, string[]][] = [];
  const calls: unknown[][] = [];
  const redis = {
    async xadd(...args: string[]) {
      calls.push(args);
      const id = `${Date.now()}-${entries.length}`;
      entries.push([id, args.slice(-2)]);
      return id;
    },
    async xrange(_key: string, from: string, to: string) {
      return entries.filter(([id]) => {
        const at = Number(id.split('-')[0]);
        return at >= Number(from) && at <= Number(to);
      });
    }
  };
  return { redis: redis as unknown as Redis, calls };
}

const completed = (model: string, extra: Partial<JobRecord> = {}): JobRecord => ({
  kind: 'generate',
  model,
  outcome: 'completed',
  queueWaitMs: 100,
  executionMs: 1000,
  promptTokens: 10,
  completionTokens: 20,
  tokensPerSecond: 20,
  ...extra
});

async function recordAt(redis: Redis, at: number, record: JobRecord) {
  vi.setSystemTime(at);
  await recordJob(redis, record);
  vi.setSystemTime(NOW);
}

describe('metrics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('maps job names to kinds', () => {
    expect(kindOf('analyze-text')).toBe('analyze');
    expect(kindOf('generate-text')).toBe('generate');
  });

  it('trims records older than the retention period when adding', async () => {
    const { redis, calls } = fakeRedis();
    await recordJob(redis, completed('m'));
    expect(calls[0].slice(0, 4)).toEqual(['test-queue:metrics', 'MINID', '~', String(NOW - 30 * 24 * HOUR)]);
  });

  it('swallows errors when recording safely', async () => {
    const redis = { xadd: () => Promise.reject(new Error('down')) } as unknown as Redis;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordJobSafely(redis, completed('m'))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Failed to record job metrics:', 'down');
    error.mockRestore();
  });

  it('reports empty stats with no records', async () => {
    const { redis } = fakeRedis();
    const stats = await getStats(redis, '24h');
    expect(stats.totals).toMatchObject({ jobs: 0, completed: 0, p50ExecutionMs: null, medianTokensPerSecond: null, costUsd: 0 });
    expect(stats.models).toEqual([]);
    expect(stats.timeline).toHaveLength(24);
    expect(stats.to).toBe(new Date(Date.UTC(2026, 9, 7, 13)).toISOString());
  });

  it('computes totals, percentiles and a per-model breakdown', async () => {
    const { redis } = fakeRedis();
    for (let i = 1; i <= 10; i++) {
      await recordAt(redis, NOW - i * 60_000, completed('qwen', { executionMs: i * 100, tokensPerSecond: i, queueWaitMs: i }));
    }
    await recordAt(redis, NOW - HOUR, completed('claude-haiku-4-5', { costUsd: 0.0015 }));
    await recordAt(redis, NOW - HOUR, completed('claude-haiku-4-5', { costUsd: 0.0025 }));
    await recordAt(redis, NOW - 2 * HOUR, { kind: 'analyze', model: 'qwen', outcome: 'failed', executionMs: 99_999 });
    await recordAt(redis, NOW - 2 * HOUR, { kind: 'generate', model: 'qwen', outcome: 'cancelled' });

    const stats = await getStats(redis, '24h');
    expect(stats.totals).toMatchObject({ jobs: 14, completed: 12, failed: 1, cancelled: 1, promptTokens: 120, completionTokens: 240, costUsd: 0.004 });

    const [qwen, claude] = stats.models;
    // Failed and cancelled jobs count as jobs but not in the timing figures
    expect(qwen).toMatchObject({ model: 'qwen', provider: 'ollama', jobs: 12, completed: 10, p50ExecutionMs: 500, p95ExecutionMs: 1000, medianTokensPerSecond: 5, p50QueueWaitMs: 5 });
    expect(claude).toMatchObject({ model: 'claude-haiku-4-5', provider: 'claude', jobs: 2, costUsd: 0.004 });
  });

  it('places records in hourly buckets and ignores older ones', async () => {
    const { redis } = fakeRedis();
    await recordAt(redis, NOW, completed('m'));
    await recordAt(redis, NOW - 3 * HOUR, completed('m'));
    await recordAt(redis, NOW - 3 * HOUR, { kind: 'generate', model: 'm', outcome: 'failed' });
    await recordAt(redis, NOW - 25 * HOUR, completed('m'));

    const stats = await getStats(redis, '24h');
    expect(stats.totals.jobs).toBe(3);
    const last = stats.timeline[23];
    expect(last).toMatchObject({ start: new Date(Date.UTC(2026, 9, 7, 12)).toISOString(), jobs: 1, completionTokens: 20 });
    expect(stats.timeline[20]).toMatchObject({ jobs: 2, completed: 1, failed: 1 });
  });

  it('uses wider buckets for longer ranges', async () => {
    const { redis } = fakeRedis();
    const week = await getStats(redis, '7d');
    expect(week.timeline).toHaveLength(28);
    expect(week.bucketMs).toBe(6 * HOUR);
    expect((await getStats(redis, '30d')).timeline).toHaveLength(30);
  });
});
