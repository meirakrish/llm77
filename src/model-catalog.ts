// A curated list of models offered for download, with their download size and parameter count looked up in
// the Ollama registry (the same place Ollama pulls from), so the figures match what a download will fetch.

export type CatalogTag = 'vision' | 'reasoning';

export interface CatalogModel {
  model: string;
  description: string;
  tags: CatalogTag[];
  // From the registry; null when it couldn't be reached
  sizeBytes: number | null;
  // e.g. "1.2B" or "494.03M"
  parameterSize: string | null;
  quantization: string | null;
}

type Curated = Pick<CatalogModel, 'model' | 'description'> & { tags?: CatalogTag[] };

// Ordered roughly from smallest to largest within each family
export const CURATED: Curated[] = [
  { model: 'gemma3:270m', description: "Google's tiniest Gemma; fast, for simple tasks" },
  { model: 'gemma3:1b', description: 'Small Gemma 3 text model' },
  { model: 'gemma3:4b', description: 'Gemma 3 that also reads images', tags: ['vision'] },
  { model: 'gemma3:12b', description: 'Larger Gemma 3 with image input', tags: ['vision'] },
  { model: 'llama3.2:1b', description: "Meta's small Llama, good on CPUs" },
  { model: 'llama3.2:3b', description: 'Llama 3.2, a solid all-rounder for its size' },
  { model: 'llama3.1:8b', description: "Meta's 8B general-purpose model" },
  { model: 'qwen2.5:0.5b', description: "Alibaba's smallest Qwen 2.5" },
  { model: 'qwen2.5:1.5b', description: 'Small Qwen 2.5, quick and capable' },
  { model: 'qwen2.5:3b', description: 'Qwen 2.5, stronger reasoning and multilingual' },
  { model: 'qwen2.5:7b', description: 'Qwen 2.5 7B general-purpose model' },
  { model: 'qwen3:0.6b', description: 'Tiny Qwen 3 with optional thinking', tags: ['reasoning'] },
  { model: 'qwen3:1.7b', description: 'Small Qwen 3 with optional thinking', tags: ['reasoning'] },
  { model: 'qwen3:4b', description: 'Qwen 3 4B with optional thinking', tags: ['reasoning'] },
  { model: 'qwen3:8b', description: 'Qwen 3 8B with optional thinking', tags: ['reasoning'] },
  { model: 'smollm2:135m', description: "Hugging Face's very small model, for experiments" },
  { model: 'smollm2:360m', description: 'Small SmolLM2' },
  { model: 'smollm2:1.7b', description: 'Largest SmolLM2' },
  { model: 'phi4-mini:3.8b', description: "Microsoft's compact model, strong at math and code" },
  { model: 'phi4:14b', description: "Microsoft's larger Phi 4" },
  { model: 'granite3.3:2b', description: "IBM's small instruction-tuned model" },
  { model: 'granite3.3:8b', description: "IBM's 8B instruction-tuned model" },
  { model: 'mistral:7b', description: "Mistral AI's 7B model" },
  { model: 'deepseek-r1:1.5b', description: 'Small reasoning model that thinks before answering', tags: ['reasoning'] },
  { model: 'deepseek-r1:8b', description: 'DeepSeek R1 reasoning, distilled to 8B', tags: ['reasoning'] },
  { model: 'gpt-oss:20b', description: "OpenAI's open-weight reasoning model; needs about 16 GB of memory", tags: ['reasoning'] },
  { model: 'moondream:1.8b', description: 'Tiny vision model that describes images', tags: ['vision'] },
  { model: 'qwen2.5vl:3b', description: 'Qwen 2.5 vision: images, documents and charts', tags: ['vision'] },
  { model: 'qwen2.5vl:7b', description: 'Larger Qwen 2.5 vision model', tags: ['vision'] },
  { model: 'llava:7b', description: 'LLaVA, a classic vision-language model', tags: ['vision'] },
  { model: 'llama3.2-vision:11b', description: "Meta's Llama with image understanding", tags: ['vision'] }
];

const REGISTRY = 'https://registry.ollama.ai/v2';
const MANIFEST_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
// Tags are occasionally re-published, so look again now and then; failed lookups are retried sooner
const CACHE_MS = 6 * 3600 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;

type Details = Pick<CatalogModel, 'sizeBytes' | 'parameterSize' | 'quantization'>;
const UNKNOWN: Details = { sizeBytes: null, parameterSize: null, quantization: null };

async function getJson(url: string, accept?: string): Promise<any> {
  const res = await fetch(url, { headers: accept ? { Accept: accept } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// The download is every layer of the manifest; the config blob names the parameter count and quantization
export async function lookUp(model: string): Promise<Details> {
  const [name, tag = 'latest'] = model.split(':');
  const path = `${REGISTRY}/library/${name}`;
  const manifest = await getJson(`${path}/manifests/${tag}`, MANIFEST_TYPE);
  const config = await getJson(`${path}/blobs/${manifest.config.digest}`);
  return {
    sizeBytes: manifest.layers.reduce((sum: number, layer: { size: number }) => sum + layer.size, 0),
    parameterSize: config.model_type || null,
    quantization: config.file_type || null
  };
}

const cache = new Map<string, { at: number; ttl: number; details: Promise<Details> }>();

function detailsOf(model: string): Promise<Details> {
  const hit = cache.get(model);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.details;
  const entry = { at: Date.now(), ttl: CACHE_MS, details: Promise.resolve(UNKNOWN) };
  entry.details = lookUp(model).catch((error) => {
    console.error(`Registry lookup for ${model} failed:`, error.message);
    entry.ttl = RETRY_MS;
    return UNKNOWN;
  });
  cache.set(model, entry);
  return entry.details;
}

export async function getCatalog(): Promise<CatalogModel[]> {
  return Promise.all(CURATED.map(async (m) => ({ tags: [], ...m, ...(await detailsOf(m.model)) })));
}

// For tests
export function clearCatalogCache() {
  cache.clear();
}
