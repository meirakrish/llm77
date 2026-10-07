import { describe, expect, it } from 'vitest';
import { extractText, UnsupportedFileError } from '../src/extract';

// A minimal one-page PDF; with no text, the page has no text layer, like a scanned image
function makePdf(text?: string): Buffer {
  const content = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

describe('extractText', () => {
  it('decodes text files as UTF-8', async () => {
    expect(await extractText('notes.md', Buffer.from('# Héllo ✓'))).toBe('# Héllo ✓');
  });

  it('strips a byte order mark', async () => {
    expect(await extractText('data.csv', Buffer.from('﻿a,b'))).toBe('a,b');
  });

  it('matches extensions case-insensitively', async () => {
    expect(await extractText('README.TXT', Buffer.from('hi'))).toBe('hi');
  });

  it('rejects text that is not valid UTF-8', async () => {
    await expect(extractText('notes.txt', Buffer.from([0x68, 0xff, 0xfe]))).rejects.toThrow(UnsupportedFileError);
  });

  it('rejects unsupported file types, listing the supported ones', async () => {
    const result = extractText('image.png', Buffer.from('x'));
    await expect(result).rejects.toThrow(UnsupportedFileError);
    await expect(result).rejects.toThrow('.txt, .md, .markdown, .csv, .log, .pdf');
  });

  it('extracts the text of a PDF', async () => {
    expect((await extractText('doc.pdf', makePdf('Hello from a PDF'))).trim()).toBe('Hello from a PDF');
  });

  it('rejects a PDF without a text layer', async () => {
    await expect(extractText('scan.pdf', makePdf())).rejects.toThrow('no extractable text');
  });

  it('rejects a file that is not really a PDF', async () => {
    await expect(extractText('fake.pdf', Buffer.from('not a pdf'))).rejects.toThrow(UnsupportedFileError);
  });
});
