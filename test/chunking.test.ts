import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/chunking';

const paragraph = (word: string, count: number) => Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ') + '.';

describe('chunkText', () => {
  it('returns short text as a single chunk', () => {
    expect(chunkText('  Hello world.  ', 100, 10)).toEqual(['Hello world.']);
  });

  it('returns no chunks for blank text', () => {
    expect(chunkText('', 100, 10)).toEqual([]);
    expect(chunkText(' \n\n \t ', 100, 10)).toEqual([]);
  });

  it('normalizes line endings, trailing spaces and runs of blank lines', () => {
    expect(chunkText('a  \r\nb\r\n\r\n\r\n\r\nc', 100, 10)).toEqual(['a\nb\n\nc']);
  });

  it('keeps every chunk within the size limit', () => {
    const text = [paragraph('alpha', 60), paragraph('beta', 80), paragraph('gamma', 40)].join('\n\n');
    const chunks = chunkText(text, 200, 40);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
  });

  it('loses no words', () => {
    const text = [paragraph('alpha', 60), paragraph('beta', 80)].join('\n\n');
    const words = new Set(chunkText(text, 150, 30).flatMap((chunk) => chunk.split(/\s+/)));
    for (const word of text.split(/\s+/)) expect(words).toContain(word);
  });

  it('splits on paragraph boundaries when paragraphs fit', () => {
    const first = 'First paragraph. '.repeat(3).trim();
    const second = 'Second paragraph. '.repeat(3).trim();
    expect(chunkText(`${first}\n\n${second}`, 60, 0)).toEqual([first, second]);
  });

  it('starts each chunk with the end of the previous one', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(sentences, 120, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      // Sentences are unique, so the next chunk's first sentence must be repeated from the previous chunk
      const firstSentence = chunks[i].slice(0, chunks[i].indexOf('.') + 1);
      expect(chunks[i - 1].endsWith(firstSentence)).toBe(true);
    }
  });

  it('adds no overlap when it is zero', () => {
    const text = paragraph('word', 100);
    const chunks = chunkText(text, 100, 0);
    expect(chunks.join(' ').split(' ').length).toBe(text.split(' ').length);
  });

  it('cuts text without any separator at fixed widths', () => {
    const chunks = chunkText('x'.repeat(250), 100, 0);
    expect(chunks).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
  });
});
