import { config } from './config';
import { ollama } from './ollama-client';
import { ModelInfo, ModelsInfo } from './events';

// Serve cached details so frequent UI polling doesn't query Ollama on every request
const CACHE_MS = 15 * 1000;

async function describeModel(name: string, installed: { name: string; digest: string }[]): Promise<ModelInfo> {
  const { details } = await ollama.show({ model: name });
  const digest = installed.find((m) => m.name === name || m.name === `${name}:latest`)?.digest;
  return {
    name,
    family: details.family,
    parameterSize: details.parameter_size,
    quantization: details.quantization_level,
    digest: digest ? digest.slice(0, 12) : null
  };
}

// Installed models that can generate text (embedding-only models can't answer prompts), and which can read images
async function listLocalModels(installed: { name: string }[]): Promise<{ localModels: string[]; visionModels: string[] }> {
  const shown = await Promise.all(installed.map((m) => ollama.show({ model: m.name })));
  const having = (capability: string) => installed.filter((_, i) => shown[i].capabilities?.includes(capability)).map((m) => m.name);
  return { localModels: having('completion'), visionModels: having('vision').filter((name) => having('completion').includes(name)) };
}

async function loadModelsInfo(): Promise<ModelsInfo> {
  // Look each piece up independently so one missing model doesn't hide the rest
  const errors = new Set<string>();
  const attempt = async <T>(lookup: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await lookup();
    } catch (error: any) {
      errors.add(error.message);
      return fallback;
    }
  };

  const installed = await attempt(async () => (await ollama.list()).models, []);
  const [llmModel, embedModel, { localModels, visionModels }, ollamaVersion] = await Promise.all([
    attempt(() => describeModel(config.llmModel, installed), { name: config.llmModel }),
    attempt(() => describeModel(config.embedModel, installed), { name: config.embedModel }),
    attempt(() => listLocalModels(installed), { localModels: [], visionModels: [] }),
    attempt(async () => {
      const res = await fetch(`${config.ollamaHost}/api/version`);
      return ((await res.json()) as { version: string }).version;
    }, null)
  ]);

  const info: ModelsInfo = { llmModel, embedModel, localModels, visionModels, ollamaVersion, updatedAt: new Date().toISOString() };
  if (errors.size) info.error = [...errors].join('; ');
  return info;
}

let cached: { at: number; info: Promise<ModelsInfo> } | null = null;

export function getModelsInfo(): Promise<ModelsInfo> {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    cached = { at: Date.now(), info: loadModelsInfo() };
  }
  return cached.info;
}

// Forget the cached details, e.g. after a model was downloaded, so the next request sees it
export function invalidateModelsInfo() {
  cached = null;
}
