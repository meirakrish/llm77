# Local LLM-Backed Backend Service Workspace

A production-grade, asynchronous backend architecture built with **Node.js, TypeScript, and Express** to handle heavy Generative AI workflows locally. This project serves as an architectural blueprint for decoupling slow, resource-intensive Large Language Model (LLM) generation tasks from rapid HTTP API lifecycles.

## 🏗️ System Architecture

```
       [ Client (UI / CLI) ]
         │              ▲
  REST / │              │ Server-Sent Events
  Stream │              │ (Real-time Tokens)
         ▼              │
   ┌────────────────────┴────────────────────┐      ┌──────────────────────────┐
   │        Node.js / TypeScript API         ├─────►│ Ollama (generation and   │
   │   (Express; the only process that       │      │ embeddings)              │
   │    talks to models & the vector store)  ├─────►│ LanceDB (in-process)     │
   └──┬──────────────────────────▲───────▲───┘      └──────────────────────────┘
      │                          │       │
  Publish Job              Poll / Stream │ /internal API (token-protected):
      ▼                          │       │ generate, analyze, search, heartbeat
   ┌─────────────────────────────┴────┐  │
   │          Redis (BullMQ)          │  │
   │    (Task Queue & Event Bus)      │  │
   └──┬───────────────────────────────┘  │
      │ Process Task                     │
      ▼                                  │
   ┌─────────────────────────────────────┴───┐
   │         Asynchronous Worker             │
   │  Orchestrates jobs at concurrency 1     │
   │  (one GPU job at a time)                │
   └─────────────────────────────────────────┘
```

The worker never contacts Ollama or LanceDB itself: it asks the backend's `/internal` API, authenticated with a shared `INTERNAL_API_TOKEN`. The backend holds all service credentials and stops a model call if the worker that asked for it disconnects.

## 🚀 Core Features & Architectural Solutions

*   **Asynchronous Processing (Decoupling):** Leverages **BullMQ and Redis** to separate the fast HTTP intake layer from heavy AI processing. This guarantees the backend stays responsive under heavy load.
*   **VRAM & Contention Safeguards:** Enforces a strict `concurrency: 1` pipeline execution flow on the background worker to protect local host GPU resources and prevent Out-of-Memory (`cudaMalloc`) crashes.
*   **Token & Streaming Pipelines:** Implements a baseline **Server-Sent Events (SSE)** token execution structure using native JavaScript Async Generators.
*   **Embedded Local RAG Store:** Integrates **LanceDB** as an in-process vector table to manage semantic knowledge bases using localized text embeddings (`nomic-embed-text`). Documents (pasted text or `.txt`/`.md`/`.csv`/`.log`/`.pdf` files) are split into overlapping chunks; only chunks within a relevance cutoff reach the prompt, and every answer lists the sources it used.
*   **Deterministic Structured Outputs:** Utilizes **Zod** schema constraints alongside Ollama's structural JSON grammar layer to guarantee text transformations exactly match valid backend schemas.
*   **Performance Observability Matrix:** Captures queue latency delays, prompt/completion token consumption volumes, overall execution time, and raw throughput speeds (tokens per second).

## 🐳 Run with Docker

Every part runs as its own image, built from `docker/<name>/Dockerfile`, so the parts can be deployed and scaled separately. `docker-compose.yml` runs all of them together:
```bash
cp .env.example .env
sed -i "s/^INTERNAL_API_TOKEN=.*/INTERNAL_API_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up --build
```
Then open http://localhost:8080. The first start downloads `LLM_MODEL` and `EMBED_MODEL` (about 700 MB for the Docker defaults, `qwen2.5:0.5b` and `nomic-embed-text`), so the API waits for that before it starts. The API is also published on port 3000 for curl (`API_PORT` changes it, `FRONTEND_PORT` changes 8080). Set `LLM_MODEL` in `.env` for a bigger model.

| Image | Build | What it is | Persistent data |
|---|---|---|---|
| `llm77-frontend` | `docker build -f docker/frontend/Dockerfile -t llm77-frontend .` | The web UI served by nginx, which forwards `/api` to `API_UPSTREAM` (default `api:3000`) with streaming unbuffered. Listens on 8080 | – |
| `llm77-api` | `docker build -f docker/api/Dockerfile -t llm77-api .` | The API, with the LanceDB knowledge base embedded (a library writing files, not a separate server) | `/data/lancedb` |
| `llm77-worker` | `docker build -f docker/worker/Dockerfile -t llm77-worker .` | The worker, bundled into one file with its dependencies; talks only to Redis and the API (`API_URL`) | – |
| `llm77-ollama` | `docker build -t llm77-ollama docker/ollama` | CPU-only Ollama, about 210 MB instead of the official image's ~9 GB (it leaves out the CUDA libraries); no models included | `/models` |
| `llm77-redis` | `docker build -t llm77-redis docker/redis` | Redis with the settings BullMQ needs built in: keys are never evicted, data is persisted | `/data` |

All images run as unprivileged users with numeric IDs (so Kubernetes' `runAsNonRoot` accepts them), declare health checks, and take their settings from the environment variables in the configuration table below. The API keeps no state of its own besides the knowledge base: queues, streamed answers, cancellation and stats all live in Redis. Because the knowledge base is local files, run one API instance per knowledge base volume.

The volumes survive `docker compose down`; `docker compose down -v` deletes them.

**Options**, enabled by adding the override files to `COMPOSE_FILE` in `.env`:
* **GPU** (`docker-compose.gpu.yml`): swaps in the official `ollama/ollama` image, which includes the CUDA libraries (about a 3.8 GB download), and gives it the NVIDIA GPUs. Needs the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the Docker host.
  ```bash
  COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
  ```
* **Your own Ollama** (`docker-compose.host-ollama.yml`): skips the bundled Ollama and uses the one already running on the Docker host, with the models you have installed. Ollama has to listen beyond localhost for containers to reach it: start it with `OLLAMA_HOST=0.0.0.0` (for the systemd service, `sudo systemctl edit ollama` and add `Environment="OLLAMA_HOST=0.0.0.0"` under `[Service]`). `HOST_OLLAMA_URL` points it elsewhere.
  ```bash
  COMPOSE_FILE=docker-compose.yml:docker-compose.host-ollama.yml
  ```

All other settings in the table below can be set in `.env` too. To run without Docker, follow the steps below.

## 📋 Prerequisites

*   Node.js v22.9+ (the npm scripts use `--env-file-if-exists`)
*   Redis Server running locally (`sudo apt install redis-server`)
*   Ollama installed and running on your host machine or WSL2.

### Local Model Installation
Pull the required execution and embedding models before starting the application:
```bash
ollama pull qwen2.5:1.5b
ollama pull nomic-embed-text
```
Optionally pull a second generation model to use the frontend's Compare mode, e.g. `ollama pull qwen2.5:0.5b`.

## 🛠️ Getting Started

### 1. Installation
Clone the repository, navigate to the project directory, and install dependencies:
```bash
npm install
```
`apache-arrow` is pinned to 18.1.0, the newest version `@lancedb/lancedb` supports; don't upgrade it independently of LanceDB.

### 2. Running the Infrastructure
The backend and worker authenticate to each other with a shared token. Create a `.env` file once (it is git-ignored and loaded automatically by the npm scripts):
```bash
cp .env.example .env
sed -i "s/^INTERNAL_API_TOKEN=.*/INTERNAL_API_TOKEN=$(openssl rand -hex 32)/" .env
```
When the processes run on different machines, give each the same `INTERNAL_API_TOKEN`, and set `API_URL` for the worker.

The system operates as two decoupled processes. Open two separate terminal instances to execute the system:

*   **Terminal 1 (API Gatekeeper):**
    ```bash
    npm run dev
    ```
*   **Terminal 2 (Background Queue Worker):**
    ```bash
    npm run dev:worker
    ```

For a compiled build, run `npm run build`, then `npm start` and `npm run start:worker`.

### 3. Frontend (optional)
A small [Svelte 5](https://svelte.dev) + TypeScript web UI in `frontend/` for asking questions as conversations with follow-ups (streamed, with the knowledge base sources each answer used), comparing up to four local models side by side on the same question (speed and tokens per model), analyzing messages, and managing the knowledge base (add text, upload files, browse chunks, delete documents, test retrieval). Queued work shows its place in the queue, any run can be stopped, and answers keep streaming after a dropped connection or a page reload. A Stats tab charts jobs over time by outcome and generation speed per model, with success rate, tokens, run and queue times (median and p95) for the last 24 hours, 7 days or 30 days. Your queries and results are saved in the browser's local storage. The frontend only offers local Ollama models.

**Development (same machine):** the Vite dev server forwards `/api` requests to the backend (`API_URL`, default `http://localhost:3000`), so no CORS setup is needed.
```bash
cd frontend
npm install
npm run dev
```
Then open http://localhost:5173. Run `npm run check` to type-check the frontend.

**Separate machines:** build the frontend with the backend's URL baked in, and allow the frontend's origin on the backend.
```bash
# Frontend machine: produces static files in frontend/dist/ to serve with any web server
VITE_API_URL=http://<backend-host>:3000 npm run build

# Backend machine: allow the address the frontend is served from
CORS_ORIGINS=http://<frontend-host> npm run dev
```

### 4. Configuration
The API and worker read their settings from environment variables; the defaults match a standard local setup.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | API listen port |
| `API_PORT`, `FRONTEND_PORT` | `3000`, `8080` | Docker only: host ports for the API and the web UI |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection for BullMQ and token streaming |
| `QUEUE_NAME` | `llm-processing` | BullMQ queue shared by the API and worker |
| `INTERNAL_API_TOKEN` | *(none, required)* | Shared secret between the backend and the worker; the backend's `/internal` API stays closed without it |
| `API_URL` | `http://localhost:<PORT>` | Worker only: where to reach the backend |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Backend only: Ollama server |
| `LLM_MODEL` | `qwen2.5:1.5b` | Backend only: default generation model |
| `EMBED_MODEL` | `nomic-embed-text` | Backend only: embedding model (the vector table assumes 768 dimensions) |
| `LANCEDB_DIR` | `./.lancedb` | Backend only: LanceDB storage directory |
| `CHUNK_SIZE` | `1000` | Backend only: target characters per knowledge base chunk (applies to newly added documents) |
| `CHUNK_OVERLAP` | `150` | Backend only: characters each chunk repeats from the previous one |
| `RAG_TOP_K` | `3` | Backend only: most chunks added to an Ask prompt |
| `RAG_MAX_DISTANCE` | `0.45` | Backend only: cosine distance cutoff (0 = identical); farther chunks are left out of the prompt. Use the frontend's *Test retrieval* to tune it |
| `METRICS_RETENTION_DAYS` | `30` | How long finished-job records are kept for the stats dashboard |
| `CORS_ORIGINS` | *(none)* | Comma-separated frontend origins allowed to call the API from a browser, or `*` for any |

Queued jobs retry up to 3 times with exponential backoff, except streams and schema violations, which fail immediately. Completed jobs stay pollable for 24 hours and failed jobs for 7 days. Both processes shut down gracefully on `SIGINT`/`SIGTERM`; the worker finishes its active job first. If the backend restarts mid-generation, the worker's job fails and is retried like any transient error.

## 🔌 API Documentation & Verification

`POST /api/stream`, `/api/jobs` and `/api/analyze` accept an optional `"model"` (one listed by `GET /api/models`); without it, the worker's `LLM_MODEL` is used.

### 1. Base Stream Endpoint (Milestone 1 Testing)
Queues a RAG-grounded generation job and streams its tokens back to the client using Server-Sent Events (SSE). Generation still runs on the worker, so the `concurrency: 1` safeguard applies. Events: `queued` (`jobId`); `position` (`ahead`: jobs that will run first, sent when it changes; `null` once the job is running); `token` (`token`); then `done` (`text`, `metrics`, `sources`) or `error` (`message`, and `cancelled: true` if it was stopped). `sources` lists the knowledge base chunks the answer was grounded in (empty when nothing was relevant enough).
```bash
curl -N -X POST http://localhost:3000/api/stream   -H "Content-Type: application/json"   -d '{"prompt": "Write a short 3 sentence poem about backend engineering."}'
```

To continue a conversation, send `messages` instead of `prompt`: the turns so far, alternating `user` and `assistant` and ending with the new question. The knowledge base is searched with the newest question plus the one before it, so follow-ups like "what database does it use?" still find what "it" refers to.
```bash
curl -N -X POST http://localhost:3000/api/stream   -H "Content-Type: application/json"   -d '{"messages": [{"role": "user", "content": "Who built Project Aethelgard?"}, {"role": "assistant", "content": "Alex built it."}, {"role": "user", "content": "What database does it use?"}]}'
```

To queue the same generation without streaming, `POST /api/jobs` with the same body and poll the returned `jobId` (see section 4). The frontend's Compare mode sends one such request per model.

### 2. Manage the RAG Knowledge Base
Documents are split into overlapping chunks (`CHUNK_SIZE`/`CHUNK_OVERLAP`) and each chunk is embedded into the local LanceDB index. Ask uses at most `RAG_TOP_K` chunks, and only those within `RAG_MAX_DISTANCE` of the question, so unrelated questions get no context.
```bash
# Add pasted text ("source" is optional and defaults to the first line)
curl -X POST http://localhost:3000/api/documents   -H "Content-Type: application/json"   -d '{"source": "Aethelgard notes", "text": "Project Aethelgard is a confidential database backend built by Alex using Node.js and LanceDB in October 2026."}'

# Upload a file as the raw body (.txt, .md, .markdown, .csv, .log or .pdf, up to 20 MB)
curl -X POST --data-binary @handbook.pdf "http://localhost:3000/api/documents/upload?filename=handbook.pdf"

# List documents, view one's chunks, delete one
curl http://localhost:3000/api/documents
curl http://localhost:3000/api/documents/<documentId>
curl -X DELETE http://localhost:3000/api/documents/<documentId>

# See which chunks a question would retrieve, with distances and whether each passes the cutoff
curl -X POST http://localhost:3000/api/documents/search   -H "Content-Type: application/json"   -d '{"query": "Who built Aethelgard?"}'
```
`POST /api/seed` (`{"text": ...}`) still works as an alias for adding pasted text. Knowledge bases from older versions are migrated on first start: each old document becomes a single chunk, keeping its embedding.

### 3. Queue Structured Analysis Tasks
Submits a messy log text message to the job queue for type-safe parameter extraction. Returns an asynchronous `jobId`.
```bash
curl -X POST http://localhost:3000/api/analyze   -H "Content-Type: application/json"   -d '{"text": "Urgent! Our API billing integration is throwing 500 errors on the checkout endpoint since the last deploy. Need eyes immediately."}'
```

#### Reconnecting and cancelling
A streamed job's events are kept in a Redis Stream for an hour, and every stored event carries an SSE `id`. If the connection drops (or the page reloads), follow the job again: events after `after` (or the standard `Last-Event-ID` header) are replayed, then it continues live. Without either, it replays from the start. After the hour, a finished job's result is sent as its final event.
```bash
curl -N "http://localhost:3000/api/jobs/<jobId>/stream?after=<lastEventId>"
```
`DELETE /api/jobs/<jobId>` cancels any job: a waiting one is removed from the queue (`204`), a running one is stopped by its worker (`202`), which also stops the model call. A cancelled job ends with an `error` event (`cancelled: true`) and is not retried; already finished jobs return `409`.
```bash
curl -X DELETE http://localhost:3000/api/jobs/<jobId>
```

### 4. Fetch Job Status & Metrics Tracking
Retrieves the processed payload data alongside full execution performance diagnostics using the `jobId` returned from the ingestion queue. While the job waits, `ahead` is the number of jobs that will run before it.
```bash
curl http://localhost:3000/api/jobs/<jobId>
```

#### Example Output:
```json
{
  "jobId": "4",
  "status": "completed",
  "ahead": null,
  "data": {
    "summary": "The checkout endpoint is throwing 500 errors due to a billing integration failure since the last deployment.",
    "category": "Billing",
    "urgency": "High",
    "actionItems": [
      "Investigate API billing integration checkout 500 errors.",
      "Review the recent codebase deployment logs."
    ]
  },
  "model": "qwen2.5:1.5b",
  "metrics": {
    "queueWaitTimeMs": 14,
    "executionTimeMs": 1148,
    "promptTokens": 118,
    "completionTokens": 52,
    "totalTokens": 170,
    "tokensPerSecond": 45.29
  },
  "sources": null,
  "failedReason": null
}
```

### 5. Worker & Model Info
`GET /api/models` lists the models a prompt can run on (the installed Ollama models that can generate text). `GET /api/info` reports the models the running worker actually uses (name, family, size, quantization, digest) and the Ollama version. The worker refreshes this every 30 seconds; `workerOnline` becomes `false` within a minute if no worker is running. The frontend shows it under the title and tags each result with the model that produced it.
```bash
curl http://localhost:3000/api/info
```

### 6. Usage Stats
Every finished job (completed, failed after its last retry, or cancelled) is recorded in a Redis Stream and kept for `METRICS_RETENTION_DAYS`, independently of BullMQ's own job history (which keeps completed jobs for a day). `GET /api/stats?range=24h|7d|30d` summarizes them: totals, a per-model breakdown (jobs by outcome, median tokens per second, median and p95 run and queue times, tokens) and a timeline of jobs per period. Speed and timing figures come from completed jobs only.
```bash
curl "http://localhost:3000/api/stats?range=7d"
```

## 🧪 Tests & CI

Tests use Vitest and come in two sets. Neither needs Ollama or LanceDB: models, the knowledge base and model discovery are mocked.

* **Unit tests** (`test/*.test.ts`) need no services: chunking, conversation handling, file text extraction, usage stats, the Ollama provider, and the worker's `/internal` client against the backend's router.
* **Integration tests** (`test/integration`) run the real API and workers in-process against Redis: streaming and resuming jobs, polling, retries and permanent failures, cancelling running and waiting jobs, queue positions, usage stats and the knowledge base routes. They need a Redis used only for tests: each run uses its own queue name and deletes its keys afterwards, but local job IDs are counters that can repeat another instance's.

```bash
npm test                # unit tests (npm run test:watch to re-run on changes)
npm run typecheck       # type-check the sources and the tests

docker run -d --rm --name llm77-test-redis -p 127.0.0.1:6390:6379 redis:7-alpine
TEST_REDIS_URL=redis://127.0.0.1:6390 npm run test:integration
docker stop llm77-test-redis
```
GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and push to `main`: backend type check, unit tests and builds; integration tests against a Redis service container; and frontend `svelte-check` and build. Docker images are not built in CI.

## 📁 Project Directory Layout

```text
├── .env.example          # Template for local secrets (copy to .env)
├── .github/workflows     # CI: type checks, tests, builds and Docker image builds
├── docker                # One Dockerfile per image: api, worker, frontend (with nginx.conf), ollama, redis (with redis.conf)
├── docker-compose.yml    # Full stack; docker-compose.gpu.yml and docker-compose.host-ollama.yml are optional overrides
├── package.json          # Dependencies & development scripts
├── frontend              # Standalone Svelte + Vite web UI (own package.json)
│   └── src
│       ├── App.svelte    # Page layout: Workbench (composer & history) and Knowledge base tabs
│       └── lib           # Components, API client, persisted history store
├── test                  # Backend unit tests, and integration tests in test/integration (Vitest; settings in vitest.config.mts)
├── tsconfig.json         # TypeScript compiler configurations
└── src
    ├── app.ts            # Backend: the Express app (public API routes, /internal router) and its queues
    ├── chunking.ts       # Splits documents into overlapping chunks
    ├── chat.ts           # Conversation validation and knowledge base grounding
    ├── config.ts         # Environment-driven settings
    ├── db.ts             # Backend: LanceDB knowledge base (documents, chunks, relevance search)
    ├── events.ts         # Redis pub/sub channel & SSE stream event types
    ├── extract.ts        # Backend: text extraction from uploaded files (incl. PDF)
    ├── index.ts          # Backend entry point: connects to Redis, serves app.ts, shuts down gracefully
    ├── internal-api.ts   # Backend: token-protected /internal endpoints the worker calls
    ├── internal-client.ts   # Worker: HTTP client for the /internal endpoints
    ├── internal-protocol.ts # Request/response types shared by both sides of /internal
    ├── job-stream.ts     # Backend: replays and follows a job's events as SSE, with queue position
    ├── metrics.ts        # Per-job records and the stats summary
    ├── model-info.ts     # Backend: model discovery (installed Ollama models)
    ├── ollama-client.ts  # Backend: Ollama client
    ├── providers         # Backend: Ollama text generation & analysis
    ├── schema.ts         # Zod data structures & type inferences
    ├── worker.ts         # Worker entry point: starts the workers, shuts down gracefully
    └── workers.ts        # Worker: BullMQ job processing, heartbeats, cancellation
```
