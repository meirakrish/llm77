import type { ContextChunk } from './db';
import type { ChatMessage } from './providers/types';

// Limits for a conversation sent to the API; long ones are still cut further by the model's context window
const MAX_MESSAGES = 50;
const MAX_TOTAL_CHARS = 200_000;

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
    total += message.content.length;
    messages.push({ role: expected, content: message.content });
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
  return [...messages.slice(0, -1), { role: 'user', content: grounded }];
}
