import { Ollama } from 'ollama';

// Runtime settings, each overridable through an environment variable
export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queueName: process.env.QUEUE_NAME ?? 'llm-processing',
  ollamaHost: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
  llmModel: process.env.LLM_MODEL ?? 'qwen2.5:1.5b',
  embedModel: process.env.EMBED_MODEL ?? 'nomic-embed-text',
  lancedbDir: process.env.LANCEDB_DIR ?? './.lancedb',
};

// The ollama package's default client ignores OLLAMA_HOST, so build one that honours the config
export const ollama = new Ollama({ host: config.ollamaHost });
