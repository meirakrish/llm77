// Split documents into overlapping chunks so each embedding covers one focused passage instead of a whole document

// Coarsest boundaries first: paragraphs, then lines, sentences and words
const SEPARATORS = ['\n\n', '\n', '. ', ' '];

// Break text into pieces no longer than size, preferring the coarsest boundary that works; separators stay attached
function splitPieces(text: string, size: number, separators: string[]): string[] {
  if (text.length <= size) return [text];
  const sepIndex = separators.findIndex((sep) => text.includes(sep));
  if (sepIndex === -1) {
    // No natural boundary left (e.g. one enormous word): cut at fixed widths
    const pieces = [];
    for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
    return pieces;
  }

  const sep = separators[sepIndex];
  const parts = text.split(sep).map((part, i, all) => (i < all.length - 1 ? part + sep : part));
  return parts.flatMap((part) => splitPieces(part, size, separators.slice(sepIndex + 1)));
}

export function chunkText(text: string, size: number, overlap: number): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (normalized.length <= size) return normalized ? [normalized] : [];

  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const piece of splitPieces(normalized, size, SEPARATORS)) {
    if (length + piece.length > size && current.length) {
      chunks.push(current.join('').trim());
      // Start the next chunk with the previous one's last pieces so text cut at the boundary keeps its context
      const tail: string[] = [];
      let tailLength = 0;
      for (let i = current.length - 1; i >= 0 && tailLength + current[i].length <= overlap; i--) {
        tail.unshift(current[i]);
        tailLength += current[i].length;
      }
      [current, length] = tailLength + piece.length <= size ? [tail, tailLength] : [[], 0];
    }
    current.push(piece);
    length += piece.length;
  }
  if (current.length) chunks.push(current.join('').trim());
  return chunks.filter(Boolean);
}
