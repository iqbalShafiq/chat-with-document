export interface TextChunk {
  chunkIndex: number;
  text: string;
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 150;

export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
): TextChunk[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < normalized.length) {
    const end = Math.min(start + chunkSize, normalized.length);
    const slice = normalized.slice(start, end).trim();
    if (slice.length > 0) {
      chunks.push({ chunkIndex, text: slice });
      chunkIndex += 1;
    }
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
