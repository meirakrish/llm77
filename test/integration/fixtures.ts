import type { ModelsInfo } from '../../src/events';
import type { Provider } from '../../src/providers/types';

export const usage = { promptTokens: 7, completionTokens: 2, tokensPerSecond: 40 };

// Emits the given tokens, then finishes
export const streamsTokens = (...tokens: string[]): Provider['streamText'] => async (model, _messages, onToken) => {
  for (const token of tokens) await onToken(token);
  return { text: tokens.join(''), model, usage };
};

export const modelsInfo: ModelsInfo = {
  llmModel: { name: 'test-llm' },
  embedModel: { name: 'test-embed' },
  localModels: ['test-llm', 'qwen'],
  claude: { available: true, models: [{ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', inputPrice: 1, outputPrice: 5 }] },
  ollamaVersion: '0.0.0-test',
  updatedAt: new Date(0).toISOString()
};

// A promise to hold a job running until the test releases it
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}
