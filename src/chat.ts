import type { ContextChunk } from './db';
import type { AttachedDocument, ChatMessage } from './providers/types';

// Limits for a conversation sent to the API, attached documents included; long ones are still cut further by the
// model's context window
const MAX_MESSAGES = 50;
const MAX_TOTAL_CHARS = 200_000;
// Per question. The browser downscales images before sending them, so each is normally a few hundred KB.
export const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 4_000_000;
export const MAX_DOCUMENTS = 5;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

type Parsed<T> = T | { error: string };

function parseImages(value: unknown, at: string): Parsed<string[]> {
  if (!Array.isArray(value)) return { error: `${at}: images must be an array of base64 strings.` };
  if (value.length > MAX_IMAGES) return { error: `${at}: at most ${MAX_IMAGES} images can be attached.` };
  for (const image of value) {
    if (typeof image !== 'string' || !image || image.length > MAX_IMAGE_CHARS || !BASE64.test(image)) {
      return { error: `${at}: each image must be base64-encoded and under ${MAX_IMAGE_CHARS / 1_000_000} MB.` };
    }
  }
  return value;
}

function parseDocuments(value: unknown, at: string): Parsed<AttachedDocument[]> {
  if (!Array.isArray(value)) return { error: `${at}: documents must be an array.` };
  if (value.length > MAX_DOCUMENTS) return { error: `${at}: at most ${MAX_DOCUMENTS} documents can be attached.` };
  const documents: AttachedDocument[] = [];
  for (const doc of value) {
    if (typeof doc?.name !== 'string' || typeof doc.text !== 'string' || !doc.text.trim()) {
      return { error: `${at}: each document needs a name and non-empty text.` };
    }
    documents.push({ name: doc.name.slice(0, 200), text: doc.text });
  }
  return documents;
}

// Validate a conversation from a request body: alternating turns starting and ending with the user
export function parseMessages(value: unknown): ChatMessage[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: 'messages must be a non-empty array.' };
  if (value.length > MAX_MESSAGES) return { error: `A conversation can have at most ${MAX_MESSAGES} messages.` };

  let total = 0;
  const messages: ChatMessage[] = [];
  for (const [i, message] of value.entries()) {
    const expected = i % 2 === 0 ? 'user' : 'assistant';
    if (message?.role !== expected) {
      return { error: `Message ${i + 1} must have role "${expected}": turns alternate, starting with the user.` };
    }
    if (typeof message.content !== 'string' || !message.content.trim()) {
      return { error: `Message ${i + 1} needs non-empty text content.` };
    }
    const parsed: ChatMessage = { role: expected, content: message.content };
    total += message.content.length;
    const at = `Message ${i + 1}`;
    if (message.images !== undefined || message.documents !== undefined) {
      if (expected !== 'user') return { error: `${at}: only user messages can have attachments.` };
      if (message.images !== undefined) {
        const images = parseImages(message.images, at);
        if ('error' in images) return images;
        if (images.length) parsed.images = images;
      }
      if (message.documents !== undefined) {
        const documents = parseDocuments(message.documents, at);
        if ('error' in documents) return documents;
        if (documents.length) parsed.documents = documents;
        total += documents.reduce((sum, doc) => sum + doc.text.length, 0);
      }
    }
    messages.push(parsed);
  }
  if (messages[messages.length - 1].role !== 'user') return { error: 'The last message must be from the user.' };
  if (total > MAX_TOTAL_CHARS) return { error: `The conversation is too long (over ${MAX_TOTAL_CHARS} characters).` };
  return messages;
}

// What to search the knowledge base for: the newest question, plus the one before it so a follow-up
// like "and who maintains it?" still finds what "it" refers to
export function retrievalQuery(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'user')
    .slice(-2)
    .map((m) => m.content)
    .join('\n');
}

// Put the retrieved context into the newest question; earlier turns stay as they were asked
export function withContext(messages: ChatMessage[], sources: ContextChunk[]): ChatMessage[] {
  if (!sources.length) return messages;
  const question = messages[messages.length - 1].content;
  const grounded = `Use the following context to answer the question. If the context is not relevant, answer from your own knowledge.

Context:
${sources.map((chunk, i) => `[${i + 1}] (from "${chunk.source}") ${chunk.text}`).join('\n\n')}

Question:
${question}`;
  // Attachments stay with the question
  return [...messages.slice(0, -1), { ...messages[messages.length - 1], content: grounded }];
}

export const hasImages = (messages: ChatMessage[]) => messages.some((m) => m.images?.length);

// Put attached documents' text in front of their question, for models that only take text
export function inlineDocuments(message: ChatMessage): ChatMessage {
  if (!message.documents?.length) return message;
  const { documents, ...rest } = message;
  const files = documents.map((doc) => `Attached file "${doc.name}":\n<file>\n${doc.text.trim()}\n</file>`).join('\n\n');
  return { ...rest, content: `${files}\n\n${message.content}` };
}
