import { config } from './config';
import { startWorkers } from './workers';

// Models and the knowledge base are reached only through the backend, which needs the shared token
if (!config.internalToken) {
  console.error('INTERNAL_API_TOKEN is not set; the worker needs the same token as the backend. Exiting.');
  process.exit(1);
}

const workers = startWorkers();
console.log(`Metrics-Enabled Worker initialized and listening (backend: ${config.apiUrl})...`);

async function shutdown(signal: string) {
  console.log(`${signal} received, finishing active jobs before exiting...`);
  await workers.close();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
