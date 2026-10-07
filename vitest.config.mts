import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // src/config.ts reads these at import; fixed values keep a developer's own .env or shell from leaking into tests
    env: {
      QUEUE_NAME: 'test-queue',
      INTERNAL_API_TOKEN: 'test-token',
      LLM_MODEL: 'test-llm',
      EMBED_MODEL: 'test-embed',
      CLAUDE_MODELS: 'claude-opus-5-5,claude-haiku-4-5',
      CHUNK_SIZE: '1000',
      CHUNK_OVERLAP: '150',
      RAG_TOP_K: '3',
      RAG_MAX_DISTANCE: '0.45',
      METRICS_RETENTION_DAYS: '30'
    }
  }
});
