import { beforeEach, vi } from 'vitest';
import { searchRelevant } from '../../src/db';
import { getModelsInfo } from '../../src/model-info';
import { ollamaProvider } from '../../src/providers/ollama';
import { modelsInfo, streamsTokens } from './fixtures';

// Everything outside Redis is mocked: the models, the knowledge base and model discovery
vi.mock('../../src/providers/ollama', () => ({ ollamaProvider: { streamText: vi.fn(), analyze: vi.fn() } }));
vi.mock('../../src/model-info', () => ({ getModelsInfo: vi.fn() }));
vi.mock('../../src/db', async (importOriginal) => ({
  // Keeps the real isValidDocumentId
  ...(await importOriginal<typeof import('../../src/db')>()),
  addDocument: vi.fn(),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  deleteDocument: vi.fn(),
  searchChunks: vi.fn(),
  searchRelevant: vi.fn()
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModelsInfo).mockResolvedValue(modelsInfo);
  vi.mocked(searchRelevant).mockResolvedValue([]);
  vi.mocked(ollamaProvider.streamText).mockImplementation(streamsTokens('Hello', ' world'));
});
