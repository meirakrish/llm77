import type { Metrics } from './types';

export const formatMetrics = (m: Metrics) =>
  `${m.tokensPerSecond} tok/s · ${m.totalTokens} tokens · ${(m.executionTimeMs / 1000).toFixed(1)}s · queued ${m.queueWaitTimeMs}ms`;

// 950 / 1,045 / 12.9K / 4.2M: exact below ten thousand, compact above
export const formatCompact = (n: number) =>
  n < 10_000
    ? n.toLocaleString()
    : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

// 340ms / 2.3s / 1.5 min
export const formatDuration = (ms: number | null) =>
  ms === null ? '–' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)} min`;

// 820 KB / 1.3 GB
export function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1000;
    i++;
  }
  return `${i ? bytes.toFixed(1) : bytes} ${units[i]}`;
}
