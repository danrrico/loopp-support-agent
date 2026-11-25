import { describe, expect, it } from "vitest";
import { stage1Gate } from "@/lib/agent/evidence";
import type { RetrievalHit } from "@/lib/rag/retrieve";

function hit(similarity: number, policySlug = "returns"): RetrievalHit {
  return {
    chunkId: `local:${policySlug}:0`,
    policySlug,
    section: "Test",
    content: "Test content.",
    similarity,
    source: "local:policy_corpus",
  };
}

describe("stage1Gate — policy_question bands", () => {
  it("0.55 → answer track (boundary inclusive)", () => {
    const r = stage1Gate("policy_question", [hit(0.55)]);
    expect(r.track).toBe("answer");
    expect(r.topSimilarity).toBe(0.55);
  });

  it("0.54 → caveat track", () => {
    expect(stage1Gate("policy_question", [hit(0.54)]).track).toBe("caveat");
  });

  it("0.40 → caveat track (boundary inclusive)", () => {
    expect(stage1Gate("policy_question", [hit(0.4)]).track).toBe("caveat");
  });

  it("0.39 → escalate", () => {
    expect(stage1Gate("policy_question", [hit(0.39)]).track).toBe("escalate");
  });

  it("zero surviving chunks → escalate", () => {
    const r = stage1Gate("policy_question", []);
    expect(r.track).toBe("escalate");
    expect(r.topSimilarity).toBeNull();
    expect(r.survivingChunks).toBe(0);
  });

  it("one surviving chunk is sufficient evidence (no <2 penalty)", () => {
    const r = stage1Gate("policy_question", [hit(0.9)]);
    expect(r.track).toBe("answer");
    expect(r.survivingChunks).toBe(1);
  });

  it("complaint uses the same bands", () => {
    expect(stage1Gate("complaint", [hit(0.9)]).track).toBe("answer");
    expect(stage1Gate("complaint", []).track).toBe("escalate");
  });
});

describe("stage1Gate — refund", () => {
  it("returns/billing rules retrievable → proceed", () => {
    const r = stage1Gate("refund", [hit(0.5, "returns"), hit(0.45, "billing")]);
    expect(r.track).toBe("answer");
  });

  it("no rule chunks → escalate before any tool call", () => {
    const r = stage1Gate("refund", [hit(0.9, "shipping")]);
    expect(r.track).toBe("escalate");
  });

  it("zero chunks → escalate", () => {
    expect(stage1Gate("refund", []).track).toBe("escalate");
  });
});

describe("stage1Gate — ungated intents", () => {
  it("order_status always proceeds (tool-answered)", () => {
    const r = stage1Gate("order_status", []);
    expect(r.track).toBe("answer");
    expect(r.topSimilarity).toBeNull();
  });

  it("chit_chat / other proceed without retrieval", () => {
    expect(stage1Gate("chit_chat", []).track).toBe("answer");
    expect(stage1Gate("other", []).track).toBe("answer");
  });

  it("human_request / sensitive never pass the gate", () => {
    expect(stage1Gate("human_request", [hit(0.99)]).track).toBe("escalate");
    expect(stage1Gate("sensitive", [hit(0.99)]).track).toBe("escalate");
  });
});
