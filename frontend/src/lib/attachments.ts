import { extractText } from './api';
import type { Attachment, AttachmentInfo, ChatMessage } from './types';

// Same limits as the API (src/chat.ts)
export const MAX_IMAGES = 4;
export const MAX_DOCUMENTS = 5;
// What the file picker offers: images, and the document types the API can read
export const DOCUMENT_TYPES = '.pdf,.txt,.md,.markdown,.csv,.log';

// Vision models work on far smaller images than photos, so larger ones are scaled down before upload
const MAX_SIDE = 1536;
const KEEP_AS_IS_BYTES = 1_500_000;

const isImage = (file: File) => file.type.startsWith('image/');

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).slice((reader.result as string).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Small JPEGs and PNGs go as they are; anything else is re-encoded as a JPEG of at most MAX_SIDE pixels
async function encodeImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} is not an image this browser can read.`);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= KEEP_AS_IS_BYTES && (file.type === 'image/jpeg' || file.type === 'image/png')) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  // Transparent areas would otherwise turn black
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`Could not convert ${file.name}.`))), 'image/jpeg', 0.9)
  );
}

export async function readAttachment(file: File): Promise<Attachment> {
  const id = crypto.randomUUID();
  if (isImage(file)) {
    const blob = await encodeImage(file);
    return { id, name: file.name || 'Pasted image', kind: 'image', data: await base64(blob), preview: URL.createObjectURL(blob) };
  }
  return { id, name: file.name, kind: 'document', text: await extractText(file) };
}

export const describe = (attachments: Attachment[]): AttachmentInfo[] => attachments.map(({ name, kind }) => ({ name, kind }));

// A question with its attachments, as the API takes it
export function userMessage(content: string, attachments: Attachment[] = []): ChatMessage {
  const images = attachments.flatMap((a) => (a.kind === 'image' ? [a.data] : []));
  const documents = attachments.flatMap((a) => (a.kind === 'document' ? [{ name: a.name, text: a.text }] : []));
  return { role: 'user', content, ...(images.length ? { images } : {}), ...(documents.length ? { documents } : {}) };
}

// Analyze takes plain text, so attached documents are appended to it
export function withDocuments(text: string, attachments: Attachment[] = []): string {
  const docs = attachments.flatMap((a) => (a.kind === 'document' ? [`--- ${a.name} ---\n${a.text}`] : []));
  return [text, ...docs].join('\n\n');
}
