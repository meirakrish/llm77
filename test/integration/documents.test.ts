import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDocument, deleteDocument, getDocument, listDocuments, searchChunks } from '../../src/db';
import { client, startStack, type Stack } from './stack';

let stack: Stack;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  stack = await startStack({ workers: false });
  api = client(stack);
});
afterAll(() => stack?.stop());

const summary = { id: 'doc-1', source: 'notes.md', createdAt: '2026-10-07T00:00:00.000Z', chunkCount: 2, charCount: 1500, preview: 'Hello' };

function upload(filename: string | null, body: string | Uint8Array) {
  const query = filename === null ? '' : `?filename=${encodeURIComponent(filename)}`;
  return fetch(`${stack.url}/api/documents/upload${query}`, { method: 'POST', body: body as BodyInit });
}

describe('knowledge base routes', () => {
  it('lists documents', async () => {
    vi.mocked(listDocuments).mockResolvedValue([summary]);
    expect(await api.get('/api/documents')).toEqual({ status: 200, body: { documents: [summary] } });
  });

  it('stores pasted text, named after its first line unless a source is given', async () => {
    vi.mocked(addDocument).mockResolvedValue(summary);
    expect(await api.post('/api/documents', { text: '\n  Release notes  \nVersion 2' })).toEqual({
      status: 201,
      body: { message: 'Document stored as 2 chunk(s).', document: summary }
    });
    expect(addDocument).toHaveBeenLastCalledWith('\n  Release notes  \nVersion 2', 'Release notes');

    await api.post('/api/documents', { text: 'x'.repeat(100) });
    expect(addDocument).toHaveBeenLastCalledWith('x'.repeat(100), 'x'.repeat(57) + '…');

    await api.post('/api/documents', { text: 'body', source: '  Handbook ' });
    expect(addDocument).toHaveBeenLastCalledWith('body', 'Handbook');

    await api.post('/api/seed', { text: 'Seeded' });
    expect(addDocument).toHaveBeenLastCalledWith('Seeded', 'Seeded');
  });

  it.each([
    [{}, 'Text content is required.'],
    [{ text: '   ' }, 'Text content is required.'],
    [{ text: 'hi', source: 3 }, 'source must be a string.']
  ])('rejects %j', async (body, error) => {
    expect(await api.post('/api/documents', body)).toEqual({ status: 400, body: { error } });
    expect(addDocument).not.toHaveBeenCalled();
  });

  it('reports a storage failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(addDocument).mockRejectedValue(new Error('embedding model not found'));
    expect(await api.post('/api/documents', { text: 'hi' })).toEqual({
      status: 500,
      body: { error: 'Failed to store document: embedding model not found' }
    });
  });

  it('stores an uploaded file under its file name', async () => {
    vi.mocked(addDocument).mockResolvedValue(summary);
    const res = await upload('notes.md', '# Notes\nSome text');
    expect(res.status).toBe(201);
    expect(addDocument).toHaveBeenCalledWith('# Notes\nSome text', 'notes.md');
  });

  it('rejects uploads it cannot read', async () => {
    expect((await upload(null, 'x')).status).toBe(400);
    expect((await upload('empty.txt', '')).status).toBe(400);
    expect((await upload('blank.txt', '  \n ')).status).toBe(400);
    const unsupported = await upload('photo.png', 'x');
    expect(unsupported.status).toBe(415);
    expect((await unsupported.json()).error).toContain('Unsupported file type');
    expect((await upload('bad.txt', new Uint8Array([0xff, 0xfe]))).status).toBe(415);
    expect(addDocument).not.toHaveBeenCalled();
  });

  it('marks search results against the relevance cutoff', async () => {
    vi.mocked(searchChunks).mockResolvedValue([
      { docId: 'd1', source: 'a.md', chunkIndex: 0, text: 'near', distance: 0.2 },
      { docId: 'd2', source: 'b.md', chunkIndex: 3, text: 'far', distance: 0.6 }
    ]);
    const { body } = await api.post('/api/documents/search', { query: 'q' });
    expect(body.maxDistance).toBe(0.45);
    expect(body.results.map((r: { text: string; relevant: boolean }) => [r.text, r.relevant])).toEqual([['near', true], ['far', false]]);
    expect((await api.post('/api/documents/search', {})).status).toBe(400);
  });

  it('gets and deletes documents by ID', async () => {
    vi.mocked(getDocument).mockResolvedValue({ ...summary, chunks: [{ index: 0, text: 'Hello' }] });
    expect((await api.get('/api/documents/doc-1')).body.chunks).toEqual([{ index: 0, text: 'Hello' }]);
    vi.mocked(getDocument).mockResolvedValue(null);
    expect((await api.get('/api/documents/doc-2')).status).toBe(404);

    vi.mocked(deleteDocument).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await api.delete('/api/documents/doc-1')).status).toBe(204);
    expect((await api.delete('/api/documents/doc-1')).status).toBe(404);
  });

  it('never passes an ID that could alter the query to the knowledge base', async () => {
    const id = encodeURIComponent("x' OR '1'='1");
    expect((await api.get(`/api/documents/${id}`)).status).toBe(404);
    expect((await api.delete(`/api/documents/${id}`)).status).toBe(404);
    expect(getDocument).not.toHaveBeenCalled();
    expect(deleteDocument).not.toHaveBeenCalled();
  });
});

describe('reading a file to attach', () => {
  const extract = (filename: string | null, body: string) =>
    fetch(`${stack.url}/api/extract${filename === null ? '' : `?filename=${encodeURIComponent(filename)}`}`, { method: 'POST', body });

  it('returns the text without storing anything', async () => {
    vi.mocked(addDocument).mockClear();
    const res = await extract('notes.md', '  # Notes\nSome text\n');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '# Notes\nSome text' });
    expect(addDocument).not.toHaveBeenCalled();
  });

  it('rejects files it cannot read or that are too long to attach', async () => {
    expect((await extract(null, 'x')).status).toBe(400);
    expect((await extract('blank.txt', ' \n')).status).toBe(400);
    expect((await extract('photo.png', 'x')).status).toBe(415);
    const long = await extract('book.txt', 'x'.repeat(100_001));
    expect(long.status).toBe(413);
    expect((await long.json()).error).toContain('Add it to the knowledge base instead');
  });
});
