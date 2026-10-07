const list = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

// Runtime settings, each overridable through an environment variable
export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queueName: process.env.QUEUE_NAME ?? 'llm-processing',
  ollamaHost: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
  llmModel: process.env.LLM_MODEL ?? 'qwen2.5:1.5b',
  embedModel: process.env.EMBED_MODEL ?? 'nomic-embed-text',
  lancedbDir: process.env.LANCEDB_DIR ?? './.lancedb',
  // Documents are split into chunks of about this many characters, each repeating up to chunkOverlap from the previous one
  chunkSize: Number(process.env.CHUNK_SIZE ?? 1000),
  chunkOverlap: Number(process.env.CHUNK_OVERLAP ?? 150),
  // How many chunks to add to a prompt, and how close (cosine distance, 0 = identical) they must be to count as relevant
  ragTopK: Number(process.env.RAG_TOP_K ?? 3),
  ragMaxDistance: Number(process.env.RAG_MAX_DISTANCE ?? 0.45),
  // Long prompts (e.g. an attached document) get a context window this large at most; more uses more memory
  maxContextTokens: Number(process.env.MAX_CONTEXT_TOKENS ?? 16384),
  // How long finished-job records are kept for the stats dashboard
  metricsRetentionDays: Number(process.env.METRICS_RETENTION_DAYS ?? 30),
  // Comma-separated frontend origins allowed to call the API from a browser, or '*' for any; empty allows none
  corsOrigins: list(process.env.CORS_ORIGINS ?? '').map((o) => o.replace(/\/$/, '')),
  // Shared secret the worker sends to the backend's /internal endpoints; unset disables them
  internalToken: process.env.INTERNAL_API_TOKEN ?? '',
  // Where the worker reaches the backend
  apiUrl: (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ''),
};
