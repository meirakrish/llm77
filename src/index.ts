import IORedis from 'ioredis';
import { createApp } from './app';
import { config } from './config';

const redisConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const api = createApp(redisConnection);
if (!config.internalToken) console.warn('INTERNAL_API_TOKEN is not set: the worker cannot reach the internal API.');

const server = api.app.listen(config.port, () => {
  console.log(`API Layer listening at http://localhost:${config.port}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down API...`);
  server.close();
  // Open SSE streams would otherwise keep the server alive indefinitely
  server.closeAllConnections();
  await api.close();
  await redisConnection.quit();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
