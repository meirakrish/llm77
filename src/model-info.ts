import { config } from './config';
import { ollama } from './ollama-client';
import { ClaudeInfo, ModelInfo, ModelsInfo } from './events';
import { checkClaudeModels } from './providers/claude';

// Serve cached details so frequent UI polling doesn't query Ollama on every request
const CACHE_MS = 15 * 1000;
// Re-check Claude access this often once it works (a failing check is retried on every refresh)
const CLAUDE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

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

// Installed models that can generate text; embedding-only models can't answer prompts
async function listLocalModels(installed: { name: string }[]): Promise<string[]> {
  const shown = await Promise.all(installed.map((m) => ollama.show({ model: m.name })));
  return installed.filter((_, i) => shown[i].capabilities?.includes('completion')).map((m) => m.name);
}

let claudeInfo: ClaudeInfo = { available: false, models: [] };
let claudeCheckedAt = 0;

async function refreshClaudeInfo() {
  if (claudeInfo.available && Date.now() - claudeCheckedAt < CLAUDE_CHECK_INTERVAL_MS) return claudeInfo;
  claudeInfo = await checkClaudeModels(config.claudeModels);
  claudeCheckedAt = Date.now();
  return claudeInfo;
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
  const [llmModel, embedModel, localModels, ollamaVersion, claude] = await Promise.all([
    attempt(() => describeModel(config.llmModel, installed), { name: config.llmModel }),
    attempt(() => describeModel(config.embedModel, installed), { name: config.embedModel }),
    attempt(() => listLocalModels(installed), []),
    attempt(async () => {
      const res = await fetch(`${config.ollamaHost}/api/version`);
      return ((await res.json()) as { version: string }).version;
    }, null),
    // Claude problems are reported on their own so they don't flag Ollama as unhealthy
    refreshClaudeInfo().catch((error): ClaudeInfo => ({ available: false, models: [], error: error.message }))
  ]);

  const info: ModelsInfo = { llmModel, embedModel, localModels, claude, ollamaVersion, updatedAt: new Date().toISOString() };
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
