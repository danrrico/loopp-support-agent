import { tokenize } from "@/lib/rag/text";

/**
 * Embeddings behind an interface (architecture-v2.md §2.2).
 *
 * Production embedder: OpenAI `text-embedding-3-small` (1536 dims) — lands
 * when OPENAI_API_KEY exists. Until then, `MockEmbedder` provides
 * deterministic word-overlap embeddings so the ingestion pipeline
 * (chunk → embed → upsert) runs end to end with no key and no network
 * calls.
 *
 * The mock is honest about what it is: cosine similarity over hashed word
 * counts, i.e. keyword overlap, NOT semantic similarity. Retrieval quality
 * with the mock is keyword-quality, and the calibration eval must NOT set
 * production thresholds from mock similarities (scripts/eval-retrieval.ts
 * refuses to do so). Demo-mode retrieval uses the IDF-overlap local search
 * (lib/rag/local-search.ts), which behaves better for short queries than
 * raw cosine over long chunks.
 */

export interface Embedder {
  /** Embedding dimension (1536 for text-embedding-3-small and the mock). */
  readonly dims: number;
  /** Embed a batch of texts. Returns one vector per input, same order. */
  embed(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_DIMS = 1536;

/**
 * Deterministic word-overlap embedder.
 *
 * Each word hashes (FNV-1a) to a bucket; the vector counts words per bucket
 * and is L2-normalized. Texts sharing words score higher — enough for the
 * demo's retrieval path to return sensible chunks, and fully deterministic
 * (same text → same vector, every run).
 */
export class MockEmbedder implements Embedder {
  readonly dims = EMBEDDING_DIMS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedText(text, this.dims));
  }
}

function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function embedText(text: string, dims: number = EMBEDDING_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const words = tokenize(text);
  // Sublinear term frequency (1 + log tf) so a word repeated 10 times in a
  // long chunk does not dominate the vector.
  const counts = new Map<number, number>();
  for (const word of words) {
    const bucket = fnv1a(word) % dims;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  for (const [bucket, count] of counts) {
    vec[bucket] = 1 + Math.log(count);
  }
  // L2-normalize so cosine similarity = dot product.
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** Cosine similarity between two same-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Factory: returns the embedder for the current environment.
 *
 * Today this always returns the mock — the OpenAI embedder lands with the
 * key (TODO(key): return OpenAIEmbeddings from @langchain/openai when
 * OPENAI_API_KEY is set). No code path calls a real embedding API until then.
 */
export function getEmbedder(): Embedder {
  return new MockEmbedder();
}
