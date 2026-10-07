import { describe, expect, it } from 'vitest';
import { inlineDocuments, parseMessages, retrievalQuery, withContext } from '../src/chat';
import type { ContextChunk } from '../src/db';
import type { ChatMessage } from '../src/providers/types';

const turns = (...contents: string[]) =>
  contents.map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content }) as ChatMessage);

describe('parseMessages', () => {
  it('accepts an alternating conversation ending with the user', () => {
    expect(parseMessages(turns('hi', 'hello', 'how are you?'))).toEqual(turns('hi', 'hello', 'how are you?'));
  });

  it('drops fields other than role and content', () => {
    expect(parseMessages([{ role: 'user', content: 'hi', extra: true }])).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('keeps images and documents attached to user turns', () => {
    const messages = [{ role: 'user', content: 'What is this?', images: ['aGVsbG8='], documents: [{ name: 'a.md', text: 'Alpha' }] }];
    expect(parseMessages(messages)).toEqual(messages);
  });

  it('leaves out empty attachment lists', () => {
    expect(parseMessages([{ role: 'user', content: 'hi', images: [], documents: [] }])).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('counts attached documents toward the length limit', () => {
    const result = parseMessages([{ role: 'user', content: 'hi', documents: [{ name: 'big.txt', text: 'x'.repeat(200_000) }] }]);
    expect(result).toEqual({ error: expect.stringContaining('too long') });
  });

  it.each([
    ['images that are not an array', { images: 'aGVsbG8=' }, 'images must be an array'],
    ['an image that is not base64', { images: ['data:image/png;base64,aGVsbG8='] }, 'base64-encoded'],
    ['too many images', { images: Array(5).fill('aGVsbG8=') }, 'at most 4 images'],
    ['a document without text', { documents: [{ name: 'a.md', text: ' ' }] }, 'needs a name and non-empty text'],
    ['too many documents', { documents: Array(6).fill({ name: 'a', text: 'b' }) }, 'at most 5 documents']
  ])('rejects %s', (_name, attachments, error) => {
    expect(parseMessages([{ role: 'user', content: 'hi', ...attachments }])).toEqual({ error: expect.stringContaining(error) });
  });

  it('rejects attachments on assistant turns', () => {
    const result = parseMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'a', images: ['aGVsbG8='] }, { role: 'user', content: 'b' }]);
    expect(result).toEqual({ error: 'Message 2: only user messages can have attachments.' });
  });

  it.each([
    ['not an array', 'hi', 'non-empty array'],
    ['an empty array', [], 'non-empty array'],
    ['a first turn from the assistant', [{ role: 'assistant', content: 'hi' }], 'Message 1 must have role "user"'],
    ['two user turns in a row', [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], 'Message 2 must have role "assistant"'],
    ['a null entry', [null], 'Message 1 must have role "user"'],
    ['blank content', [{ role: 'user', content: '  ' }], 'Message 1 needs non-empty text content'],
    ['non-string content', [{ role: 'user', content: 42 }], 'Message 1 needs non-empty text content'],
    ['a last turn from the assistant', turns('hi', 'hello'), 'last message must be from the user'],
    ['too many messages', turns(...Array.from({ length: 51 }, () => 'x')), 'at most 50 messages'],
    ['too much text', turns('x'.repeat(200_001)), 'too long']
  ])('rejects %s', (_name, value, error) => {
    const result = parseMessages(value);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain(error);
  });
});

describe('retrievalQuery', () => {
  it('uses the only question when there is one', () => {
    expect(retrievalQuery(turns('What is LanceDB?'))).toBe('What is LanceDB?');
  });

  it('combines the last two questions so follow-ups keep their subject', () => {
    expect(retrievalQuery(turns('old question', 'a', 'What is LanceDB?', 'b', 'who maintains it?'))).toBe(
      'What is LanceDB?\nwho maintains it?'
    );
  });
});

describe('withContext', () => {
  const chunk = (source: string, text: string): ContextChunk => ({ docId: 'd', source, chunkIndex: 0, text, distance: 0.1 });

  it('leaves the conversation unchanged without sources', () => {
    const messages = turns('hi');
    expect(withContext(messages, [])).toBe(messages);
  });

  it('puts numbered sources into the last question only', () => {
    const messages = turns('first', 'answer', 'second');
    const result = withContext(messages, [chunk('a.md', 'Alpha text'), chunk('b.md', 'Beta text')]);

    expect(result.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(result[2].role).toBe('user');
    expect(result[2].content).toContain('[1] (from "a.md") Alpha text');
    expect(result[2].content).toContain('[2] (from "b.md") Beta text');
    expect(result[2].content).toMatch(/Question:\nsecond$/);
    expect(messages[2].content).toBe('second');
  });

  it('keeps the question\'s attachments', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'q', images: ['aGVsbG8='], documents: [{ name: 'a.md', text: 'A' }] }];
    const [grounded] = withContext(messages, [chunk('b.md', 'Beta')]);
    expect(grounded).toMatchObject({ images: ['aGVsbG8='], documents: [{ name: 'a.md', text: 'A' }] });
  });
});

describe('inlineDocuments', () => {
  it('puts each attached file in front of the question', () => {
    const message: ChatMessage = { role: 'user', content: 'Summarize these', images: ['aGVsbG8='], documents: [{ name: 'a.md', text: ' Alpha \n' }, { name: 'b.pdf', text: 'Beta' }] };
    expect(inlineDocuments(message)).toEqual({
      role: 'user',
      content: 'Attached file "a.md":\n<file>\nAlpha\n</file>\n\nAttached file "b.pdf":\n<file>\nBeta\n</file>\n\nSummarize these',
      images: ['aGVsbG8=']
    });
  });

  it('leaves messages without documents alone', () => {
    const message: ChatMessage = { role: 'user', content: 'hi' };
    expect(inlineDocuments(message)).toBe(message);
  });
});
