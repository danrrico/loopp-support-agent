/**
 * The ONLY retrieval entry point (architecture-v2.md §2.3).
 *
 * One function serves the graph, the KB tool, and (via the graph) voice.
 * There is no separate FTS path and no unscored evidence.
 *
 * - Embeds the query (Embedder interface — mock until the OpenAI key lands).
 * - With Supabase configured: calls the `match_policies` RPC, which returns
 *   similarity = 1 - distance (pgvector `<=>` is cosine distance; no caller
 *   converts distance to similarity).
 * - Without Supabase (demo mode): IDF-overlap keyword search over the local
 *   policy corpus (data/policies/*.md, chunked in memory — see
 *   lib/rag/local-search.ts). Same top-k, same floor, same result shape —
 *   the graph cannot tell the difference. Scores are keyword-overlap, not
 *   embedding cosine; the calibration eval must not set production
 *   thresholds from them.
 *
 * Top-k = 5. Chunks below the provisional floor (0.30) are dropped.
 * Zero surviving chunks → the pre-gate escalates (policy intents). One
 * surviving chunk is sufficient evidence if it clears the floor.
 */

import fs from "node:fs";
import path from "node:path";
import { RETRIEVAL_FLOOR } from "@/lib/agent/thresholds";
import { chunkPolicy } from "@/lib/rag/chunk";
import { getEmbedder, type Embedder } from "@/lib/rag/embeddings";
import {
  LocalSearch,
  type SearchableChunk,
} from "@/lib/rag/local-search";
import { getServiceClient } from "@/lib/supabase/server";

export interface RetrievalHit {
  chunkId: string;
  policySlug: string;
  section: string;
  content: string;
  /** Cosine similarity (Supabase path) or IDF-overlap score (demo mode), 0–1. Higher = more relevant. */
  similarity: number;
}

export interface RetrieveOptions {
  topK?: number;
  /** Override the embedder (tests / eval). Defaults to getEmbedder(). */
  embedder?: Embedder;
}

export const RETRIEVAL_TOP_K = 5;

export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievalHit[]> {
  const topK = opts.topK ?? RETRIEVAL_TOP_K;
  const embedder = opts.embedder ?? getEmbedder();

  const client = getServiceClient();
  if (client) {
    const [queryEmbedding] = await embedder.embed([query]);
    const { data, error } = await client.rpc("match_policies", {
      query_embedding: queryEmbedding,
      match_count: topK,
    });
    if (error) {
      throw new Error(`match_policies RPC failed: ${error.message}`);
    }
    return ((data ?? []) as Array<{
      id: string;
      policy_slug: string;
      section: string;
      content: string;
      similarity: number;
    }>)
      .filter((row) => row.similarity >= RETRIEVAL_FLOOR)
      .map((row) => ({
        chunkId: row.id,
        policySlug: row.policy_slug,
        section: row.section,
        content: row.content,
        similarity: row.similarity,
      }));
  }

  // Demo mode: IDF-overlap keyword search over the local corpus.
  const search = await getLocalSearch();
  return search
    .search(query, topK)
    .filter((hit) => hit.similarity >= RETRIEVAL_FLOOR);
}

// ---------------------------------------------------------------------------
// Local corpus (demo mode only — used when Supabase is not configured).
// ---------------------------------------------------------------------------

let localSearchCache: LocalSearch | null = null;

export async function getLocalSearch(): Promise<LocalSearch> {
  if (localSearchCache) return localSearchCache;
  const dir = path.join(process.cwd(), "data", "policies");
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    // Policy files not present in this runtime (e.g. a serverless bundle
    // without the data dir traced). Retrieval degrades to zero hits and the
    // pre-gate escalates policy questions honestly.
    console.warn("[rag] data/policies not found — local corpus is empty");
    localSearchCache = new LocalSearch([]);
    return localSearchCache;
  }

  const chunks: SearchableChunk[] = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const markdown = fs.readFileSync(path.join(dir, file), "utf-8");
    for (const chunk of chunkPolicy(markdown)) {
      chunks.push({
        chunkId: `local:${slug}:${chunk.chunkIndex}`,
        policySlug: slug,
        section: chunk.section,
        content: chunk.content,
      });
    }
  }
  localSearchCache = new LocalSearch(chunks);
  return localSearchCache;
}

/** Test hook: clear the cached local corpus. */
export function __resetLocalCorpusCache(): void {
  localSearchCache = null;
}
