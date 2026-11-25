import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stage1Gate } from "@/lib/agent/evidence";
import { chunkPolicy } from "@/lib/rag/chunk";
import {
  cosineSimilarity,
  embedText,
  MockEmbedder,
} from "@/lib/rag/embeddings";
import {
  rescoreCandidates,
  retrieve,
  RETRIEVAL_MOCK_CANDIDATES,
  type RpcCandidate,
} from "@/lib/rag/retrieve";

/**
 * Regression test for the Nov 25 RAG pre-gate bug: "What is your return
 * policy?" escalated live because raw cosine similarity between the short
 * 2-word query and the long returns chunks tops out at 0.24 — below the
 * 0.30 floor — so zero chunks survived and the pre-gate escalated.
 *
 * These tests simulate the Supabase path exactly: the candidate pool is
 * the cosine-ranked top-N over the real corpus (what match_policies
 * returns), then rescoreCandidates re-ranks it by IDF-overlap, the same
 * formula the demo path uses.
 */

function loadCorpus(): RpcCandidate[] {
  const dir = path.join(process.cwd(), "data", "policies");
  const candidates: RpcCandidate[] = [];
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    const slug = file.replace(/\.md$/, "");
    const markdown = fs.readFileSync(path.join(dir, file), "utf-8");
    for (const chunk of chunkPolicy(markdown)) {
      candidates.push({
        id: `db:${slug}:${chunk.chunkIndex}`,
        policySlug: slug,
        section: chunk.section,
        content: chunk.content,
      });
    }
  }
  return candidates;
}

/** The RPC's ranking: cosine over the stored mock vectors, top-N. */
function rpcCandidatePool(query: string, all: RpcCandidate[]): RpcCandidate[] {
  const queryVec = embedText(query);
  return all
    .map((c) => ({
      candidate: c,
      sim: cosineSimilarity(queryVec, embedText(c.content)),
    }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, RETRIEVAL_MOCK_CANDIDATES)
    .map((r) => r.candidate);
}

describe("rescoreCandidates — mock-embedder Supabase path", () => {
  const corpus = loadCorpus();

  it("'What is your return policy?' retrieves returns chunks and answers (was: 0 chunks → stage1_fail)", () => {
    const pool = rpcCandidatePool("What is your return policy?", corpus);
    // Sanity: the bug itself — raw cosine tops out below the floor.
    const topCosine = cosineSimilarity(
      embedText("What is your return policy?"),
      embedText(pool[0].content),
    );
    expect(topCosine).toBeLessThan(0.3);

    const hits = rescoreCandidates("What is your return policy?", pool, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].policySlug).toBe("returns");
    expect(hits[0].section).toBe("60-Day Return Window");
    expect(hits[0].similarity).toBeGreaterThanOrEqual(0.55);
    expect(hits.every((h) => h.source === "supabase:policy_chunks")).toBe(true);
    expect(stage1Gate("policy_question", hits).track).toBe("answer");
  });

  it("'How long is the warranty?' still answers, from the warranty policy", () => {
    const pool = rpcCandidatePool("How long is the warranty?", corpus);
    const hits = rescoreCandidates("How long is the warranty?", pool, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].policySlug).toBe("warranty");
    expect(hits[0].similarity).toBeGreaterThanOrEqual(0.55);
    expect(stage1Gate("policy_question", hits).track).toBe("answer");
  });

  it("'Can you fix my tent pole?' still escalates (guardrail intact)", () => {
    const pool = rpcCandidatePool("Can you fix my tent pole?", corpus);
    const hits = rescoreCandidates("Can you fix my tent pole?", pool, 5);
    expect(stage1Gate("policy_question", hits).track).toBe("escalate");
  });
});

describe("retrieve() — demo mode names its source", () => {
  it("return-policy question carries source local:policy_corpus", async () => {
    // No Supabase configured in tests → demo path.
    const { hits, source } = await retrieve("What is your return policy?", {
      embedder: new MockEmbedder(),
    });
    expect(source).toBe("local:policy_corpus");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].policySlug).toBe("returns");
    expect(hits.every((h) => h.source === "local:policy_corpus")).toBe(true);
  });
});
