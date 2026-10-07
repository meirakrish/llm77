# Redis image with the settings BullMQ depends on built in (see redis.conf), so it can't be deployed
# misconfigured. Mount a persistent volume at /data. Runs as the image's redis user from the start (the
# official image otherwise starts as root and switches), so Kubernetes' runAsNonRoot accepts it.
# Build: docker build -t llm77-redis docker/redis

FROM redis:7-alpine
COPY redis.conf /usr/local/etc/redis/redis.conf
USER 999
HEALTHCHECK --interval=5s --timeout=3s --retries=5 CMD ["redis-cli", "ping"]
CMD ["redis-server", "/usr/local/etc/redis/redis.conf"]
