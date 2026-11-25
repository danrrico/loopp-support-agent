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
 * MOCK-EMBEDDER SCORING (Supabase path): raw cosine similarity over the
 * mock's hashed word-count vectors is a poor match for short queries — a
 * 2-word query shares so little mass with a 120-word chunk that even the
 * right chunk scores below the retrieval floor ("What is your return
 * policy?" tops out at 0.24 against the returns chunks, so the pre-gate
 * escalates a perfectly answerable question). The demo path already solves
 * this with IDF-overlap scoring (lib/rag/local-search.ts). So whenever the
 * embedder is the mock, the Supabase path pulls a wider candidate pool
 * from the RPC and rescores it with the SAME IDF-overlap formula, over the
 * same index text (content + policy slug + "policy" + section heading).
 * Real (OpenAI) embeddings keep cosine — this rescoring never runs for
 * them. The returned `similarity` is the score the gate actually judged,
 * whichever path produced it.
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

/** Which corpus produced a retrieval result — named on every hit and in the trace. */
export type RetrievalSource = "supabase:policy_chunks" | "local:policy_corpus";

export interface RetrievalHit {
  chunkId: string;
  policySlug: string;
  section: string;
  content: string;
  /** IDF-overlap score (mock embedder / demo mode) or cosine similarity (real embeddings), 0–1. Higher = more relevant. */
  similarity: number;
  /** Which corpus this hit came from — Supabase policy_chunks or the local corpus. */
  source: RetrievalSource;
}

export interface RetrieveResult {
  hits: RetrievalHit[];
  /** Which corpus answered this query (also carried on every hit). */
  source: RetrievalSource;
}

export interface RetrieveOptions {
  topK?: number;
  /** Override the embedder (tests / eval). Defaults to getEmbedder(). */
  embedder?: Embedder;
}

export const RETRIEVAL_TOP_K = 5;

/** RPC candidates pulled before keyword rescoring (mock path only). Wide
 *  enough that every chunk sharing a query word is in the pool — the
 *  corpus is 35 chunks and a short query's words appear in far fewer. */
export const RETRIEVAL_MOCK_CANDIDATES = 15;

/** Which corpus retrieve() will read from in this environment. */
export function getRetrievalSource(): RetrievalSource {
  return getServiceClient() ? "supabase:policy_chunks" : "local:policy_corpus";
}

/** One RPC candidate row, before rescoring. */
export interface RpcCandidate {
  id: string;
  policySlug: string;
  section: string;
  content: string;
}

/**
 * Rescore RPC candidates with IDF-overlap (same formula + index text as
 * the demo-mode local search). Exported for tests.
 *
 * Used ONLY when the embedder is the mock: the stored vectors are mock
 * hashed word-count vectors, and their cosine similarity cannot clear the
 * floor for short queries (see the module docstring). The RPC still does
 * the first-pass ranking by vector similarity; this re-ranks the candidate
 * pool by keyword overlap and applies the floor to the rescored values.
 */
export function rescoreCandidates(
  query: string,
  candidates: RpcCandidate[],
  topK: number,
): RetrievalHit[] {
  const search = new LocalSearch(
    candidates.map((c) => ({
      chunkId: c.id,
      policySlug: c.policySlug,
      section: c.section,
      content: c.content,
      // Same index text as getLocalSearch below: policy title words live
      // in metadata, not in chunk content, so without this the query word
      // "policy" matches nothing.
      indexText: `${c.policySlug} policy ${c.section}`,
    })),
  );
  return search
    .search(query, topK)
    .filter((hit) => hit.similarity >= RETRIEVAL_FLOOR)
    .map((hit) => ({
      chunkId: hit.chunkId,
      policySlug: hit.policySlug,
      section: hit.section,
      content: hit.content,
      similarity: hit.similarity,
      source: "supabase:policy_chunks" as const,
    }));
}

export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const topK = opts.topK ?? RETRIEVAL_TOP_K;
  const embedder = opts.embedder ?? getEmbedder();

  const client = getServiceClient();
  if (client) {
    const [queryEmbedding] = await embedder.embed([query]);
    const matchCount =
      embedder.kind === "mock" ? RETRIEVAL_MOCK_CANDIDATES : topK;
    const { data, error } = await client.rpc("match_policies", {
      query_embedding: queryEmbedding,
      match_count: matchCount,
    });
    if (error) {
      throw new Error(`match_policies RPC failed: ${error.message}`);
    }
    const rows = ((data ?? []) as Array<{
      id: string;
      policy_slug: string;
      section: string;
      content: string;
      similarity: number;
    }>);
    if (embedder.kind === "mock") {
      return {
        hits: rescoreCandidates(
          query,
          rows.map((row) => ({
            id: row.id,
            policySlug: row.policy_slug,
            section: row.section,
            content: row.content,
          })),
          topK,
        ),
        source: "supabase:policy_chunks",
      };
    }
    return {
      hits: rows
        .filter((row) => row.similarity >= RETRIEVAL_FLOOR)
        .map((row) => ({
          chunkId: row.id,
          policySlug: row.policy_slug,
          section: row.section,
          content: row.content,
          similarity: row.similarity,
          source: "supabase:policy_chunks" as const,
        })),
      source: "supabase:policy_chunks",
    };
  }

  // Demo mode: IDF-overlap keyword search over the local corpus.
  const search = await getLocalSearch();
  return {
    hits: search
      .search(query, topK)
      .filter((hit) => hit.similarity >= RETRIEVAL_FLOOR)
      .map((hit) => ({
        chunkId: hit.chunkId,
        policySlug: hit.policySlug,
        section: hit.section,
        content: hit.content,
        similarity: hit.similarity,
        source: "local:policy_corpus" as const,
      })),
    source: "local:policy_corpus",
  };
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
        // Policy title words + section heading, indexed for matching only.
        indexText: `${slug} policy ${chunk.section}`,
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
