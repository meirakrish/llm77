import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
    },
    projects: [
      // No services needed
      { extends: true, test: { name: 'unit', include: ['test/*.test.ts'] } },
      // The real API and workers against Redis at TEST_REDIS_URL, with models and the knowledge base mocked
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          setupFiles: ['test/integration/setup.ts'],
          // Required: see test/integration/stack.ts
          env: { REDIS_URL: process.env.TEST_REDIS_URL ?? '' },
          // Files share Redis and the cancel channel, so run them one at a time
          fileParallelism: false,
          testTimeout: 15_000,
          hookTimeout: 15_000
        }
      }
    ]
  }
});
