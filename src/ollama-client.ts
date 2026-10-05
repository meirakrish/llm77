import { Ollama } from 'ollama';
import { config } from './config';

// Backend only: the worker reaches Ollama through the backend's internal API.
// The ollama package's default client ignores OLLAMA_HOST, so build one that honours the config.
export const ollama = new Ollama({ host: config.ollamaHost });
