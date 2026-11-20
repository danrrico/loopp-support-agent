import { describe, expect, it } from "vitest";
import { extractNumbers, verifyDraft, type ToolCallForVerify } from "@/lib/agent/verify";
import type { RetrievalHit } from "@/lib/rag/retrieve";

const RETURNS_CHUNK: RetrievalHit = {
  chunkId: "local:returns:0",
  policySlug: "returns",
  section: "60-Day Return Window",
  content:
    "You can return any unused item within 60 days of the delivery date for a full refund to your original payment method.",
  similarity: 0.9,
};

const BILLING_CHUNK: RetrievalHit = {
  chunkId: "local:billing:1",
  policySlug: "billing",
  section: "Refund Timing",
  content:
    "Approved refunds are issued to your original payment method within 3 to 5 business days after inspection.",
  similarity: 0.8,
};

const CHUNKS = [RETURNS_CHUNK, BILLING_CHUNK];

function toolCall(
  tool: string,
  outcome: ToolCallForVerify["outcome"],
  resultText: string,
): ToolCallForVerify {
  return { tool, outcome, resultText };
}

describe("verifyDraft — quote-substring assert", () => {
  it("passes when the quote is a verbatim substring of the cited chunk", () => {
    const r = verifyDraft(
      {
        answerText: RETURNS_CHUNK.content,
        claims: [
          {
            text: "60-day return window",
            chunkId: "local:returns:0",
            quote:
              "You can return any unused item within 60 days of the delivery date",
          },
        ],
      },
      CHUNKS,
      [],
    );
    expect(r.passed).toBe(true);
    expect(r.failedAsserts).toEqual([]);
  });

  it("fails when the quote is not in the cited chunk", () => {
    const r = verifyDraft(
      {
        answerText: "You can return items within 60 days.",
        claims: [
          {
            text: "90-day window",
            chunkId: "local:returns:0",
            quote: "You can return any item within 90 days",
          },
        ],
      },
      CHUNKS,
      [],
    );
    expect(r.passed).toBe(false);
    expect(r.failedAsserts[0]).toMatch(/quote_substring/);
  });

  it("fails when the claim cites an unknown chunk", () => {
    const r = verifyDraft(
      {
        answerText: "Returns are easy.",
        claims: [
          { text: "x", chunkId: "local:returns:99", quote: "Returns are easy" },
        ],
      },
      CHUNKS,
      [],
    );
    expect(r.passed).toBe(false);
    expect(r.failedAsserts[0]).toMatch(/unknown chunk/);
  });
});

describe("verifyDraft — number assert", () => {
  it("'60' in the answer matches '60 days' in the chunk", () => {
    const r = verifyDraft(
      {
        answerText: "You have 60 days to return an item.",
        claims: [],
      },
      CHUNKS,
      [],
    );
    expect(r.passed).toBe(true);
  });

  it("a number absent from chunks and tools fails", () => {
    const r = verifyDraft(
      {
        answerText: "You have 90 days to return an item.",
        claims: [],
      },
      CHUNKS,
      [],
    );
    expect(r.passed).toBe(false);
    expect(r.failedAsserts[0]).toMatch(/number: 90/);
  });

  it("'$129.00' matches a tool result of 12900 cents (via serialized text)", () => {
    const r = verifyDraft(
      {
        answerText:
          "Done — refund RF-2291 for $129.00 is on its way to your original payment method.",
        claims: [],
      },
      CHUNKS,
      [
        toolCall(
          "initiateRefund",
          "ok",
          JSON.stringify({
            status: "initiated",
            refundId: "RF-2291",
            amountCents: 12900,
          }),
        ),
      ],
    );
    // 129.00 is NOT in the tool text (12900 is) — the draft must use the
    // tool's own numbers. This documents the strictness: the mock draft
    // formats $129.00 from 12900 cents, so the verifier must accept it.
    // extractNumbers("12900") -> "12900"; "129.00" normalizes to 129.
    // 129 != 12900, so this FAILS — see the next test for the fix.
    expect(r.passed).toBe(false);
  });

  it("tool results must carry display-ready numbers for the verifier", () => {
    const r = verifyDraft(
      {
        answerText:
          "Done — refund RF-2291 for $129.00 is on its way to your original payment method.",
        claims: [],
      },
      CHUNKS,
      [
        toolCall(
          "initiateRefund",
          "ok",
          JSON.stringify({
            status: "initiated",
            refundId: "RF-2291",
            amountCents: 12900,
            amountDisplay: "$129.00",
          }),
        ),
      ],
    );
    expect(r.passed).toBe(true);
  });
});

describe("extractNumbers", () => {
  it("extracts integers, decimals, and dollar amounts", () => {
    expect(extractNumbers("60-day window, $129.00, 3 to 5 days")).toEqual([
      "60",
      "129.00",
      "3",
      "5",
    ]);
  });
});

describe("verifyDraft — action-claim assert", () => {
  it("passes when a refund claim matches an executed initiateRefund", () => {
    const r = verifyDraft(
      {
        answerText:
          "Done — refund RF-2291 for $129.00 is on its way to your original payment method. Refunds are issued within 3 to 5 business days after inspection.",
        claims: [
          {
            text: "Refund timing",
            chunkId: "local:billing:1",
            quote:
              "Approved refunds are issued to your original payment method within 3 to 5 business days after inspection.",
          },
        ],
      },
      CHUNKS,
      [
        toolCall(
          "initiateRefund",
          "ok",
          JSON.stringify({
            status: "initiated",
            refundId: "RF-2291",
            amountCents: 12900,
            amountDisplay: "$129.00",
          }),
        ),
      ],
    );
    expect(r.passed).toBe(true);
  });

  it("fails when a refund is claimed with no tool call", () => {
    const r = verifyDraft(
      {
        answerText: "I've initiated your refund for $129.00.",
        claims: [],
      },
      CHUNKS,
      [],
    );
    expect(r.passed).toBe(false);
    expect(r.failedAsserts.some((a) => a.startsWith("action_claim"))).toBe(
      true,
    );
  });

  it("a return-label claim ALWAYS fails — no such tool exists", () => {
    const r = verifyDraft(
      {
        answerText: "Your return label is on its way to your email.",
        claims: [],
      },
      CHUNKS,
      [toolCall("orderLookup", "ok", "{}")],
    );
    expect(r.passed).toBe(false);
    expect(r.failedAsserts.some((a) => a.includes("return label"))).toBe(true);
  });
});
