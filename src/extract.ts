import path from 'path';
import { PDFParse } from 'pdf-parse';

// File types the knowledge base accepts, by extension
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.log'];
export const SUPPORTED_EXTENSIONS = [...TEXT_EXTENSIONS, '.pdf'];

// Thrown for files we can't read; the message is safe to show to the user
export class UnsupportedFileError extends Error {}

async function pdfText(data: Buffer): Promise<string> {
  const parser = new PDFParse({ data });
  try {
    // No "-- 1 of 3 --" page markers; they would end up embedded in chunks
    return (await parser.getText({ pageJoiner: '' })).text;
  } catch (error: any) {
    throw new UnsupportedFileError(`Could not read the PDF: ${error.message}`);
  } finally {
    await parser.destroy();
  }
}

export async function extractText(filename: string, data: Buffer): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    const text = await pdfText(data);
    // Scanned PDFs are images; there's no text layer to extract without OCR
    if (!text.trim()) throw new UnsupportedFileError('The PDF has no extractable text (it may be a scanned image).');
    return text;
  }
  if (!TEXT_EXTENSIONS.includes(ext)) {
    throw new UnsupportedFileError(`Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^﻿/, '');
  } catch {
    throw new UnsupportedFileError('The file is not valid UTF-8 text.');
  }
}
