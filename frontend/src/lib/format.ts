import type { Metrics } from './types';

// Small amounts need more decimals to be meaningful
export const formatCost = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;

export const formatMetrics = (m: Metrics) =>
  `${m.tokensPerSecond} tok/s · ${m.totalTokens} tokens · ${(m.executionTimeMs / 1000).toFixed(1)}s · queued ${m.queueWaitTimeMs}ms` +
  (m.costUsd !== undefined ? ` · ${formatCost(m.costUsd)}` : '');
