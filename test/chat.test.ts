import { describe, expect, it } from 'vitest';
import { parseMessages, retrievalQuery, withContext } from '../src/chat';
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
});
