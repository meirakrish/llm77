import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Response } from 'express';
import { CANCELLED_MESSAGE, jobEventsKey, StreamEvent } from './events';

// How long each read waits for new events before checking on the job (queue position, missed endings)
const BLOCK_MS = 1000;
// Send a comment this often while nothing else is sent, so proxies don't drop an idle connection
const KEEPALIVE_MS = 15000;

// How many jobs will run before this one: those ahead of it in the queue plus those already running,
// or null if it isn't waiting (running, finished, or delayed before a retry)
export async function jobsAhead(queue: Queue, jobId: string): Promise<number | null> {
  const [waiting, active] = await Promise.all([queue.getRanges(['waiting'], 0, -1, true), queue.getActiveCount()]);
  const index = waiting.indexOf(jobId);
  return index === -1 ? null : index + active;
}

// The event a finished job would have ended its stream with; used when the stream has expired or never had one
async function finalEvent(job: Job): Promise<StreamEvent | null> {
  const state = await job.getState();
  if (state === 'completed') {
    const { text, model, metrics, sources } = job.returnvalue ?? {};
    return { type: 'done', text, model, metrics, sources: sources ?? [] };
  }
  if (state === 'failed') {
    const message = job.failedReason || 'Job failed.';
    return { type: 'error', message, cancelled: message === CANCELLED_MESSAGE };
  }
  return null;
}

type Entries = [id: string, fields: string[]][];

// Send a generation job's events as Server-Sent Events, starting after the event ID `after` ('0' = from the start),
// until the job finishes or the client disconnects. Each event carries its stream ID so a client can resume after it.
export async function streamJobEvents(redis: IORedis, queue: Queue, jobId: string, after: string, res: Response) {
  const key = jobEventsKey(jobId);
  // Blocking reads need a connection of their own
  const reader = redis.duplicate();
  let closed = false;
  res.on('close', () => {
    closed = true;
    reader.disconnect();
  });

  const send = (type: string, data: object, id?: string) =>
    res.write(`${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  // Returns true once the final event has been sent
  const sendEntries = (entries: Entries) => {
    for (const [id, fields] of entries) {
      const { type, ...data }: StreamEvent = JSON.parse(fields[1]);
      send(type, data, id);
      after = id;
      if (type === 'done' || type === 'error') return true;
    }
    return false;
  };

  // Sent whenever it changes: jobs ahead while waiting, null once the job is running (or no longer waiting)
  let lastAhead: number | null | undefined;
  let lastWrite = Date.now();
  const reportPosition = async () => {
    const ahead = await jobsAhead(queue, jobId);
    if (ahead === lastAhead) return;
    send('position', { ahead });
    lastAhead = ahead;
    lastWrite = Date.now();
  };

  try {
    await reportPosition();
    for (;;) {
      if (closed) return;
      const result = (await reader.xread('BLOCK', BLOCK_MS, 'STREAMS', key, after)) as [string, Entries][] | null;
      if (result) {
        if (sendEntries(result[0][1])) break;
        lastWrite = Date.now();
        continue;
      }

      // Nothing new for a while: the job is waiting in the queue, or it ended without (more) events
      const job = await queue.getJob(jobId);
      if (!job) {
        send('error', { message: 'Job not found. It may have been cancelled or expired from the queue.' });
        break;
      }
      const final = await finalEvent(job);
      if (final) {
        // Its last events may have been written just before it finished
        const late = (await reader.xread('STREAMS', key, after)) as [string, Entries][] | null;
        if (late && sendEntries(late[0][1])) break;
        const { type, ...data } = final;
        send(type, data);
        break;
      }
      await reportPosition();
      if (Date.now() - lastWrite > KEEPALIVE_MS) {
        res.write(': keep-alive\n\n');
        lastWrite = Date.now();
      }
    }
  } catch (error: any) {
    // Disconnecting the reader on close interrupts its pending read; that's expected. Otherwise end without a
    // final event, so the client reconnects instead of treating the job as failed
    if (!closed) console.error(`Event stream for job ${jobId} failed:`, error.message);
  }
  reader.disconnect();
  res.end();
}
