# Slim, CPU-only Ollama (about 150 MB instead of the official image's ~9 GB unpacked). The official
# release bundles NVIDIA CUDA libraries (over 2 GB) that a CPU-only setup never loads; the archive is
# streamed and unpacked without them, so it is never stored whole. Models are not included: the
# model volume is filled with `ollama pull` (the compose file's ollama-pull service does it); mount it at
# /models. Runs as an unprivileged user (UID 10001). For NVIDIA GPUs use the official ollama/ollama image instead (docker-compose.gpu.yml).
# Build: docker build -t llm77-ollama docker/ollama

FROM debian:bookworm-slim AS download
ARG OLLAMA_VERSION=0.35.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl zstd \
 && mkdir /ollama \
 && curl -fsSL "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-linux-amd64.tar.zst" \
    | zstd -dc \
    | tar -x -C /ollama --exclude='lib/ollama/cuda_*' --exclude='lib/ollama/vulkan'

FROM debian:bookworm-slim
# Certificates for downloading models over HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=download /ollama/bin/ollama /usr/bin/ollama
COPY --from=download /ollama/lib/ollama /usr/lib/ollama
# Ollama keeps its identity key under $HOME/.ollama and the models in OLLAMA_MODELS; a volume mounted at
# /models starts out owned by this user
RUN useradd --uid 10001 --create-home --home-dir /home/ollama ollama \
 && mkdir /models && chown ollama:ollama /models
ENV OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_MODELS=/models
USER 10001
EXPOSE 11434
HEALTHCHECK --interval=5s --timeout=5s --retries=20 CMD ["ollama", "list"]
ENTRYPOINT ["/usr/bin/ollama"]
CMD ["serve"]
