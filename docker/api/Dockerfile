# API image: Express, the LanceDB knowledge base (an embedded library: its data is files under
# LANCEDB_DIR, so mount a persistent volume there) and PDF parsing.
# Build from the repository root: docker build -f docker/api/Dockerfile -t llm77-api .
# Debian rather than Alpine: LanceDB's native module is built against glibc.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Compiling needs only type definitions; skipping optional packages avoids ~1.1 GB of native binaries
RUN npm ci --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Optional packages are skipped: LanceDB's optional @huggingface/transformers (with the ONNX runtime, ~840 MB)
# only backs its own embedding helper, and embeddings here come from Ollama. The two optional native modules
# that are needed, LanceDB's and the canvas module the PDF parser loads at startup, are then added at the
# versions in package-lock.json, for this machine's architecture.
RUN npm ci --omit=dev --omit=optional \
 && version() { node -p "require('./package-lock.json').packages['node_modules/$1'].version"; } \
 && arch=$(node -p process.arch) \
 && npm install --no-save --omit=optional \
      "@lancedb/lancedb-linux-$arch-gnu@$(version @lancedb/lancedb-linux-x64-gnu)" \
      "@napi-rs/canvas-linux-$arch-gnu@$(version @napi-rs/canvas-linux-x64-gnu)" \
 && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    LANCEDB_DIR=/data/lancedb
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# A volume mounted here starts out owned by the unprivileged user
RUN mkdir -p /data/lancedb && chown -R node:node /data
# Numeric (the image's node user) so Kubernetes' runAsNonRoot can verify it
USER 1000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
