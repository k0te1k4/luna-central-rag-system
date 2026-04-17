import * as fs from 'fs/promises';
import * as path from 'path';

export type IndexedChunk = {
  id: string;
  sourcePath: string; // relative to wiki root
  heading: string | null;
  text: string;
  embedding: number[];
};

export type IndexFile = {
  schemaVersion: 1;
  createdAt: string;
  modelUri: string;
  chunkChars: number;
  chunks: IndexedChunk[];
};

export async function loadIndex(indexAbsPath: string): Promise<IndexFile | null> {
  try {
    const raw = await fs.readFile(indexAbsPath, 'utf8');
    const parsed = JSON.parse(raw) as IndexFile;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed?.chunks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveIndex(indexAbsPath: string, idx: IndexFile): Promise<void> {
  await fs.mkdir(path.dirname(indexAbsPath), { recursive: true });
  await fs.writeFile(indexAbsPath, JSON.stringify(idx, null, 2), 'utf8');
}

export function cosineSim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  if (!den) return 0;
  return dot / den;
}

export function topKBySimilarity(query: number[], chunks: IndexedChunk[], k: number): Array<{ chunk: IndexedChunk; score: number }> {
  const scored = chunks.map(chunk => ({ chunk, score: cosineSim(query, chunk.embedding) }));
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, Math.max(1, k));
}
