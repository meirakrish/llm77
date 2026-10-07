import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCatalogCache, CURATED, getCatalog, lookUp } from '../src/model-catalog';

const fetchMock = vi.fn();

// Registry responses for one model: a manifest whose config blob holds the details
function registry(url: string) {
  const body = url.includes('/manifests/')
    ? { config: { digest: 'sha256:cfg' }, layers: [{ size: 1_000_000 }, { size: 2500 }, { size: 500 }] }
    : { model_type: '1.2B', file_type: 'Q8_0' };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => {
  clearCatalogCache();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('model catalog', () => {
  it('sums the manifest layers and reads the parameter count from the config blob', async () => {
    fetchMock.mockImplementation(registry);
    expect(await lookUp('llama3.2:1b')).toEqual({ sizeBytes: 1_003_000, parameterSize: '1.2B', quantization: 'Q8_0' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://registry.ollama.ai/v2/library/llama3.2/manifests/1b',
      'https://registry.ollama.ai/v2/library/llama3.2/blobs/sha256:cfg'
    ]);
  });

  it('lists every curated model and caches the lookups', async () => {
    fetchMock.mockImplementation(registry);
    const catalog = await getCatalog();
    expect(catalog).toHaveLength(CURATED.length);
    expect(catalog.find((m) => m.model === 'moondream:1.8b')).toMatchObject({ tags: ['vision'], sizeBytes: 1_003_000, parameterSize: '1.2B' });
    const calls = fetchMock.mock.calls.length;
    await getCatalog();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('still lists models when the registry is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const catalog = await getCatalog();
    expect(catalog).toHaveLength(CURATED.length);
    expect(catalog[0]).toMatchObject({ sizeBytes: null, parameterSize: null, quantization: null });
  });
});
