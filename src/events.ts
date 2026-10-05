// Redis pub/sub channel the worker publishes streamed tokens to for a given job
export const streamChannel = (jobId: string) => `llm-stream:${jobId}`;

export type StreamEvent =
  | { type: 'token'; token: string }
  | { type: 'done'; text: string; metrics: Record<string, number> }
  | { type: 'error'; message: string };
