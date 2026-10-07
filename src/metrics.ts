import type { Redis } from 'ioredis';
import { config } from './config';

// One record per finished job, kept in a Redis Stream (entry IDs are timestamps) for the stats dashboard.
// Unlike BullMQ's job history, which keeps completed jobs for a day, these last METRICS_RETENTION_DAYS.
const metricsKey = () => `${config.queueName}:metrics`;
const DAY_MS = 24 * 3600 * 1000;

export type JobKind = 'generate' | 'analyze';
export type JobOutcome = 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  kind: JobKind;
  model: string;
  outcome: JobOutcome;
  queueWaitMs?: number;
  // Measured by the worker; for failures, how long it ran before failing
  executionMs?: number;
  // Only for completed jobs
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
}

export const kindOf = (jobName: string): JobKind => (jobName === 'analyze-text' ? 'analyze' : 'generate');

// Append a record, trimming those past the retention period
export async function recordJob(redis: Redis, record: JobRecord): Promise<void> {
  const oldest = Date.now() - config.metricsRetentionDays * DAY_MS;
  await redis.xadd(metricsKey(), 'MINID', '~', String(oldest), '*', 'record', JSON.stringify(record));
}

// Never let a metrics problem fail or slow down the job it describes
export function recordJobSafely(redis: Redis, record: JobRecord): Promise<void> {
  return recordJob(redis, record).catch((error) => console.error('Failed to record job metrics:', error.message));
}

type StampedRecord = JobRecord & { at: number };

async function readRecords(redis: Redis, from: number, to: number): Promise<StampedRecord[]> {
  const entries = await redis.xrange(metricsKey(), String(from), String(to));
  return entries.map(([id, fields]) => ({ at: Number(id.split('-')[0]), ...JSON.parse(fields[1]) }));
}

// Nearest-rank percentile of an unsorted list; null when empty
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const sum = (values: (number | undefined)[]) => values.reduce<number>((total, v) => total + (v ?? 0), 0);
const round = (value: number | null, digits = 0) => (value === null ? null : Number(value.toFixed(digits)));

function counts(records: StampedRecord[]) {
  return {
    jobs: records.length,
    completed: records.filter((r) => r.outcome === 'completed').length,
    failed: records.filter((r) => r.outcome === 'failed').length,
    cancelled: records.filter((r) => r.outcome === 'cancelled').length
  };
}

// Token, speed and timing figures come from completed jobs only
function performance(records: StampedRecord[]) {
  const done = records.filter((r) => r.outcome === 'completed');
  const executions = done.flatMap((r) => (r.executionMs === undefined ? [] : [r.executionMs]));
  const waits = done.flatMap((r) => (r.queueWaitMs === undefined ? [] : [r.queueWaitMs]));
  return {
    promptTokens: sum(done.map((r) => r.promptTokens)),
    completionTokens: sum(done.map((r) => r.completionTokens)),
    medianTokensPerSecond: round(percentile(done.flatMap((r) => (r.tokensPerSecond ? [r.tokensPerSecond] : [])), 50), 1),
    p50ExecutionMs: round(percentile(executions, 50)),
    p95ExecutionMs: round(percentile(executions, 95)),
    p50QueueWaitMs: round(percentile(waits, 50)),
    p95QueueWaitMs: round(percentile(waits, 95))
  };
}

export const STATS_RANGES = { '24h': { ms: DAY_MS, buckets: 24 }, '7d': { ms: 7 * DAY_MS, buckets: 28 }, '30d': { ms: 30 * DAY_MS, buckets: 30 } };
export type StatsRange = keyof typeof STATS_RANGES;

// Totals, a per-model breakdown and a timeline for the given range, ending at the next full hour
export async function getStats(redis: Redis, range: StatsRange) {
  const { ms, buckets } = STATS_RANGES[range];
  const to = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const from = to - ms;
  const records = await readRecords(redis, from, to);
  const bucketMs = ms / buckets;

  const models = [...new Set(records.map((r) => r.model))].map((model) => {
    const own = records.filter((r) => r.model === model);
    return { model, ...counts(own), ...performance(own) };
  });
  models.sort((a, b) => b.jobs - a.jobs || a.model.localeCompare(b.model));

  const timeline = Array.from({ length: buckets }, (_, i) => {
    const start = from + i * bucketMs;
    const own = records.filter((r) => r.at >= start && r.at < start + bucketMs);
    return { start: new Date(start).toISOString(), ...counts(own), completionTokens: sum(own.map((r) => r.completionTokens)) };
  });

  return {
    range,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucketMs,
    retentionDays: config.metricsRetentionDays,
    totals: { ...counts(records), ...performance(records) },
    models,
    timeline
  };
}
