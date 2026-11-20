/**
 * IDF-overlap keyword search — DEMO MODE ONLY.
 *
 * Used by retrieve() when Supabase is not configured. It exists because
 * raw cosine similarity over long chunks is a poor match for short queries:
 * a 2-word query shares so little mass with a 120-word chunk that even the
 * right chunk scores below the retrieval floor. Production retrieval uses
 * real embeddings + the match_policies RPC and never touches this module.
 *
 * Score = Σ idf(shared query words) / Σ idf(all query words), bounded
 * [0, 1]. Rare words (high IDF) count more than common ones, and a query
 * word that appears in NO chunk penalizes the score (its IDF sits in the
 * denominator) — so questions about absent topics score low and escalate,
 * which is the correct behavior.
 *
 * Scores from this module are keyword-overlap scores, NOT embedding cosine
 * similarities. They share the [0, 1] shape and the same thresholds so the
 * graph behaves identically — but the calibration eval must NOT set
 * production thresholds from them.
 */

import { tokenize } from "@/lib/rag/text";

export interface SearchableChunk {
  chunkId: string;
  policySlug: string;
  section: string;
  content: string;
  /**
   * Extra text indexed for matching but NOT part of the chunk content
   * (policy title words + section heading). Users say "return policy" —
   * the word "policy" lives in the H1 title, which chunking drops from
   * content, so without this the query word is unknown to the index and
   * drags the score below the floor. Drafts and verifier quotes still use
   * `content` only.
   */
  indexText?: string;
}

export interface ScoredHit extends SearchableChunk {
  similarity: number;
}

export class LocalSearch {
  private readonly docFreq = new Map<string, number>();
  private readonly chunkTokens: Array<Set<string>>;
  private readonly chunkCounts: Array<Map<string, number>>;
  private readonly numDocs: number;

  constructor(private readonly chunks: SearchableChunk[]) {
    this.numDocs = chunks.length;
    const indexable = (chunk: SearchableChunk): string =>
      chunk.indexText ? `${chunk.content} ${chunk.indexText}` : chunk.content;
    this.chunkTokens = chunks.map((chunk) => {
      const tokens = new Set(tokenize(indexable(chunk)));
      for (const token of tokens) {
        this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
      }
      return tokens;
    });
    this.chunkCounts = chunks.map((chunk) => {
      const counts = new Map<string, number>();
      for (const token of tokenize(indexable(chunk))) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      return counts;
    });
  }

  private idf(token: string): number {
    const df = this.docFreq.get(token) ?? 0;
    return Math.log((this.numDocs + 1) / (df + 1)) + 1;
  }

  search(query: string, topK: number): ScoredHit[] {
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0) return [];
    const totalIdf = queryTokens.reduce((sum, t) => sum + this.idf(t), 0);
    if (totalIdf === 0) return [];

    return this.chunks
      .map((chunk, i) => {
        let shared = 0;
        let matchCount = 0;
        for (const token of queryTokens) {
          if (this.chunkTokens[i].has(token)) {
            shared += this.idf(token);
            matchCount += this.chunkCounts[i].get(token) ?? 0;
          }
        }
        return { ...chunk, similarity: shared / totalIdf, matchCount };
      })
      .filter((hit) => hit.similarity > 0)
      // Ties on similarity break toward the chunk that mentions the query
      // words most often (term frequency) — for "How long is the warranty?",
      // the 2-year section beats the repaired-items section.
      .sort(
        (a, b) => b.similarity - a.similarity || b.matchCount - a.matchCount,
      )
      .slice(0, topK)
      .map(({ matchCount: _matchCount, ...hit }) => hit);
  }
}
