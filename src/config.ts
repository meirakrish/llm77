const list = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
const queueName = process.env.QUEUE_NAME ?? 'llm-processing';

// Runtime settings, each overridable through an environment variable
export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queueName,
  // Claude jobs don't use the local GPU, so they get their own queue and run in parallel
  cloudQueueName: `${queueName}-cloud`,
  cloudConcurrency: Number(process.env.CLOUD_CONCURRENCY ?? 4),
  // Claude models users may pick; the worker only advertises the ones its credentials can access
  claudeModels: list(process.env.CLAUDE_MODELS ?? 'claude-opus-5-5,claude-haiku-4-5'),
  ollamaHost: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
  llmModel: process.env.LLM_MODEL ?? 'qwen2.5:1.5b',
  embedModel: process.env.EMBED_MODEL ?? 'nomic-embed-text',
  lancedbDir: process.env.LANCEDB_DIR ?? './.lancedb',
  // Comma-separated frontend origins allowed to call the API from a browser, or '*' for any; empty allows none
  corsOrigins: list(process.env.CORS_ORIGINS ?? '').map((o) => o.replace(/\/$/, '')),
  // Shared secret the worker sends to the backend's /internal endpoints; unset disables them
  internalToken: process.env.INTERNAL_API_TOKEN ?? '',
  // Where the worker reaches the backend
  apiUrl: (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ''),
};
