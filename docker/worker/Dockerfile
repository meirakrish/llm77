# Worker image: the worker only needs Redis (BullMQ) and the API's internal endpoints, so it is bundled
# into one file with its dependencies and runs without node_modules.
# Build from the repository root: docker build -f docker/worker/Dockerfile -t llm77-worker .
# No HTTP server, so no HEALTHCHECK: liveness shows in the API's /api/info (workerOnline) via heartbeats.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Bundling needs only BullMQ, ioredis and esbuild; skipping optional packages avoids ~1.1 GB of native
# binaries (esbuild fetches its own binary when its optional package is skipped)
RUN npm ci --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:worker

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/worker.bundle.js ./worker.js
# Numeric (the image's node user) so Kubernetes' runAsNonRoot can verify it
USER 1000
CMD ["node", "worker.js"]
