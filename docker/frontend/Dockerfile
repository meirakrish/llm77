# Frontend image: the static build served by nginx, which also forwards /api to the API, so the browser
# talks to a single origin (no CORS setup). The API's address comes from API_UPSTREAM (default api:3000).
# Build from the repository root: docker build -f docker/frontend/Dockerfile -t llm77-frontend .

FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
# Empty VITE_API_URL: the app calls /api on its own origin
RUN npm run build

# The unprivileged variant of the official nginx image: runs as UID 101 and listens on 8080
FROM nginxinc/nginx-unprivileged:1.27-alpine
ENV API_UPSTREAM=api:3000
# nginx's entrypoint fills ${API_UPSTREAM} into templates at startup
COPY docker/frontend/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
