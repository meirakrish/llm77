# Local LLM-Backed Backend Service Workspace

A production-grade, asynchronous backend architecture built with **Node.js, TypeScript, and Express** to handle heavy Generative AI workflows locally. This project serves as an architectural blueprint for decoupling slow, resource-intensive Large Language Model (LLM) generation tasks from rapid HTTP API lifecycles.

## 🏗️ System Architecture

```
       [ Client (UI / CLI) ]
         │              ▲
  REST / │              │ Server-Sent Events
  Stream │              │ (Real-time Tokens)
         ▼              │
   ┌────────────────────┴────────────────────┐
   │        Node.js / TypeScript API         │
   │            (Express Engine)             │
   └─────────┬──────────────────────▲────────┘
             │                      │
       Publish Job             Poll / Stream
             ▼                      │
   ┌────────────────────────────────┴────────┐
   │            Redis (BullMQ)               │
   │       (Task Queue & Event Bus)          │
   └─────────┬───────────────────────────────┘
             │
       Process Task (Concurrency: 1)
             ▼
   ┌─────────────────────────────────────────┐
   │         Asynchronous Worker             │
   │  • Ollama (Qwen 2.5 1.5B / Llama 3.2)   │
   │  • Vector Store (LanceDB In-Process)    │
   └─────────────────────────────────────────┘
```

## 🚀 Core Features & Architectural Solutions

*   **Asynchronous Processing (Decoupling):** Leverages **BullMQ and Redis** to separate the fast HTTP intake layer from heavy AI processing. This guarantees the backend stays responsive under heavy load.
*   **VRAM & Contention Safeguards:** Enforces a strict `concurrency: 1` pipeline execution flow on the background worker to protect local host GPU resources and prevent Out-of-Memory (`cudaMalloc`) crashes.
*   **Token & Streaming Pipelines:** Implements a baseline **Server-Sent Events (SSE)** token execution structure using native JavaScript Async Generators.
*   **Embedded Local RAG Store:** Integrates **LanceDB** as an in-process vector table to manage semantic knowledge bases using localized text embeddings (`nomic-embed-text`).
*   **Deterministic Structured Outputs:** Utilizes **Zod** schema constraints alongside Ollama's structural JSON grammar layer to guarantee text transformations exactly match valid backend schemas.
*   **Performance Observability Matrix:** Captures queue latency delays, prompt/completion token consumption volumes, overall execution time, and raw throughput speeds (tokens per second).

## 📋 Prerequisites

*   Node.js (v22+ recommended)
*   Redis Server running locally (`sudo apt install redis-server`)
*   Ollama installed and running on your host machine or WSL2.

### Local Model Installation
Pull the required execution and embedding models before starting the application:
```bash
ollama pull qwen2.5:1.5b
ollama pull nomic-embed-text
```

## 🛠️ Getting Started

### 1. Installation
Clone the repository, navigate to the project directory, and install dependencies bypassing conflicting native peer dependencies:
```bash
npm install --legacy-peer-deps
```

### 2. Running the Infrastructure
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
A small web UI in `frontend/` for asking questions (streamed), analyzing messages and adding knowledge. Your queries and results are saved in the browser's local storage.

**Development (same machine):** the Vite dev server forwards `/api` requests to the backend (`API_URL`, default `http://localhost:3000`), so no CORS setup is needed.
```bash
cd frontend
npm install
npm run dev
```
Then open http://localhost:5173.

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
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection for BullMQ and token streaming |
| `QUEUE_NAME` | `llm-processing` | BullMQ queue shared by the API and worker |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server |
| `LLM_MODEL` | `qwen2.5:1.5b` | Generation model |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model (the vector table assumes 768 dimensions) |
| `LANCEDB_DIR` | `./.lancedb` | LanceDB storage directory |
| `CORS_ORIGINS` | *(none)* | Comma-separated frontend origins allowed to call the API from a browser, or `*` for any |

Queued jobs retry up to 3 times with exponential backoff, except streams and schema violations, which fail immediately. Completed jobs stay pollable for 24 hours and failed jobs for 7 days. Both processes shut down gracefully on `SIGINT`/`SIGTERM`; the worker finishes its active job first.

## 🔌 API Documentation & Verification

### 1. Base Stream Endpoint (Milestone 1 Testing)
Queues a RAG-grounded generation job and streams its tokens back to the client using Server-Sent Events (SSE). Generation still runs on the worker, so the `concurrency: 1` safeguard applies. Events: `queued` (`jobId`), `token` (`token`), then `done` (`text`, `metrics`) or `error` (`message`).
```bash
curl -N -X POST http://localhost:3000/api/stream   -H "Content-Type: application/json"   -d '{"prompt": "Write a short 3 sentence poem about backend engineering."}'
```

To queue the same generation without streaming, `POST /api/jobs` with the same body and poll the returned `jobId` (see section 4).

### 2. Seed RAG Knowledge Base
Injects domain-specific background context into the local LanceDB vector index.
```bash
curl -X POST http://localhost:3000/api/seed   -H "Content-Type: application/json"   -d '{"text": "Project Aethelgard is a confidential database backend built by Alex using Node.js and LanceDB in October 2026."}'
```

### 3. Queue Structured Analysis Tasks
Submits a messy log text message to the job queue for type-safe parameter extraction. Returns an asynchronous `jobId`.
```bash
curl -X POST http://localhost:3000/api/analyze   -H "Content-Type: application/json"   -d '{"text": "Urgent! Our API billing integration is throwing 500 errors on the checkout endpoint since the last deploy. Need eyes immediately."}'
```

### 4. Fetch Job Status & Metrics Tracking
Retrieves the processed payload data alongside full execution performance diagnostics using the `jobId` returned from the ingestion queue.
```bash
curl http://localhost:3000/api/jobs/<jobId>
```

#### Example Output:
```json
{
  "jobId": "4",
  "status": "completed",
  "data": {
    "summary": "The checkout endpoint is throwing 500 errors due to a billing integration failure since the last deployment.",
    "category": "Billing",
    "urgency": "High",
    "actionItems": [
      "Investigate API billing integration checkout 500 errors.",
      "Review the recent codebase deployment logs."
    ]
  },
  "metrics": {
    "queueWaitTimeMs": 14,
    "executionTimeMs": 1148,
    "promptTokens": 118,
    "completionTokens": 52,
    "totalTokens": 170,
    "tokensPerSecond": 45.29
  },
  "failedReason": null
}
```

## 📁 Project Directory Layout

```text
├── package.json          # Dependencies & development scripts
├── frontend              # Standalone Vite web UI (own package.json)
├── tsconfig.json         # TypeScript compiler configurations
└── src
    ├── config.ts         # Environment-driven settings & Ollama client
    ├── db.ts             # LanceDB connection mapping layers
    ├── events.ts         # Redis pub/sub channel & SSE stream event types
    ├── index.ts          # Express Server API interface definitions
    ├── schema.ts         # Zod data structures & type inferences
    └── worker.ts         # BullMQ queue execution worker routine
```
