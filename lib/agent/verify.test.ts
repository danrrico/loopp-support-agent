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
  source: "local:policy_corpus",
};

const BILLING_CHUNK: RetrievalHit = {
  chunkId: "local:billing:1",
  policySlug: "billing",
  section: "Refund Timing",
  content:
    "Approved refunds are issued to your original payment method within 3 to 5 business days after inspection.",
  similarity: 0.8,
  source: "local:policy_corpus",
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

  it("a policy restatement ('Refunds are issued...') does NOT fail with no tool call", () => {
    // Nov 25 live: the draft faithfully repeated the Refund Timing chunk
    // ("Approved refunds are issued to your original payment method
    // within 3 to 5 business days") and the action-claim assert flagged
    // it — the policy sentence itself matches the refund+issued pattern.
    // A matched phrase that appears verbatim in a retrieved chunk is a
    // restatement of policy, not a claim that an action was taken.
    const r = verifyDraft(
      {
        answerText:
          "You can return any unused item within 60 days of the delivery date for a full refund to your original payment method. Approved refunds are issued to your original payment method within 3 to 5 business days after inspection.",
        claims: [
          {
            text: "You can return any unused item within 60 days of the delivery date for a full refund to your original payment method.",
            chunkId: "local:returns:0",
            quote:
              "You can return any unused item within 60 days of the delivery date for a full refund to your original payment method.",
          },
          {
            text: "Approved refunds are issued to your original payment method within 3 to 5 business days after inspection.",
            chunkId: "local:billing:1",
            quote:
              "Approved refunds are issued to your original payment method within 3 to 5 business days after inspection.",
          },
        ],
      },
      CHUNKS,
      [],
    );
    expect(r.failedAsserts).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("a policy restatement does not mask a genuine action claim later in the answer", () => {
    const r = verifyDraft(
      {
        answerText:
          "Approved refunds are issued to your original payment method within 3 to 5 business days after inspection. I've initiated your refund for $129.00.",
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

// Nov 25 live, second round: the verbatim exemption (b42becc) did NOT fix
// the return-policy question. gpt-4o-mini's real drafts paraphrase and the
// regex spans sentence boundaries, so verbatim almost never fires:
//   - "for a full refund or replacement. Refunds are issued within 3 to 5
//     business days" (cross-sentence span "refund or replacement.
//     Refunds are issued")
//   - "a new gift card ... will be issued instead of a refund"
// The fix is (noun, verb) attestation: the pairing (refund, issued) is
// attested in the Refund Timing chunk, so both drafts pass. These tests
// use the REAL chunk contents from supabase/load-sql/returns.sql.
const RETURN_WINDOW_FULL: RetrievalHit = {
  chunkId: "supabase:returns:0",
  policySlug: "returns",
  section: "60-Day Return Window",
  content:
    "You can return any unused item within 60 days of the delivery date for a full refund to your original payment method. The item must be in its original condition, with tags attached and all included accessories. Footwear must be tried on indoors only; boots with worn soles are not eligible for return.\n\nTo start a return, sign in to your account and open the order, then select the items you want to return — for example, to return a jacket, open the order that contains it and select the jacket. You can print a prepaid return label from your account page. Drop the package at any carrier location listed on the label.",
  similarity: 1.0,
  source: "supabase:policy_chunks",
};

const REFUND_TIMING_FULL: RetrievalHit = {
  chunkId: "supabase:returns:1",
  policySlug: "returns",
  section: "Refund Timing",
  content:
    "Once your return arrives at our warehouse, we inspect it within 2 business days. Approved refunds are issued to your original payment method within 3 to 5 business days after inspection. Your bank may take an additional 1 to 2 business days to post the credit. Refunds are always issued for the full purchase price of the returned item, including any discount applied at checkout.\n\nIf you paid with a gift card, the refund is issued as a new gift card for the same amount. Shipping charges from the original order are not refunded unless the return is due to our error or a defective item.",
  similarity: 1.0,
  source: "supabase:policy_chunks",
};

const DEFECTIVE_FULL: RetrievalHit = {
  chunkId: "supabase:returns:2",
  policySlug: "returns",
  section: "Defective or Damaged Items",
  content:
    "If your item arrives defective or damaged, contact us within 30 days of delivery. We will cover the return shipping and offer a replacement or a full refund, whichever you prefer. You do not need to return a defective item before we ship a replacement for orders under $200. For orders over $200, we ask you to return the item first so our team can inspect it.",
  similarity: 1.0,
  source: "supabase:policy_chunks",
};

const RETURN_POLICY_CHUNKS = [
  RETURN_WINDOW_FULL,
  REFUND_TIMING_FULL,
  DEFECTIVE_FULL,
];

describe("verifyDraft — (noun, verb) attestation (return-policy live failure)", () => {
  it("passes a real gpt-4o-mini draft: cross-sentence 'refund or replacement. Refunds are issued'", () => {
    const r = verifyDraft(
      {
        answerText:
          "You can return any unused item within 60 days of the delivery date for a full refund to your original payment method. If your item is defective or damaged, contact us for a full refund or replacement. Refunds are issued within 3 to 5 business days after inspection of the returned item.",
        claims: [
          {
            text: "60-day return window",
            chunkId: "supabase:returns:0",
            quote:
              "You can return any unused item within 60 days of the delivery date for a full refund to your original payment method.",
          },
          {
            text: "refunds issued 3 to 5 business days",
            chunkId: "supabase:returns:1",
            quote:
              "Approved refunds are issued to your original payment method within 3 to 5 business days after inspection.",
          },
        ],
      },
      RETURN_POLICY_CHUNKS,
      [],
    );
    expect(r.failedAsserts).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("passes a real gpt-4o-mini draft: 'will be issued instead of a refund'", () => {
    const r = verifyDraft(
      {
        answerText:
          "You can return any unused item within 60 days of the delivery date for a full refund, provided it's in its original condition with tags attached and all accessories included. Some items are not eligible for return, such as underwear, socks, swimwear, water bottles, and any items marked as 'Final Sale'. If an item is defective or damaged, please contact us within 30 days for a replacement or a full refund, with return shipping covered by us. Once your return arrives, we inspect it within 2 business days and issue refunds back to your original payment method within 3 to 5 business days after inspection. If you return a gift card, a new gift card for the same amount will be issued instead of a refund.",
        claims: [
          {
            text: "60-day return window",
            chunkId: "supabase:returns:0",
            quote:
              "You can return any unused item within 60 days of the delivery date for a full refund to your original payment method.",
          },
          {
            text: "defective items 30 days",
            chunkId: "supabase:returns:2",
            quote:
              "If your item arrives defective or damaged, contact us within 30 days of delivery.",
          },
          {
            text: "refunds issued 3 to 5 business days",
            chunkId: "supabase:returns:1",
            quote:
              "Approved refunds are issued to your original payment method within 3 to 5 business days after inspection.",
          },
          {
            text: "gift card refund issued as new gift card",
            chunkId: "supabase:returns:1",
            quote:
              "If you paid with a gift card, the refund is issued as a new gift card for the same amount.",
          },
        ],
      },
      RETURN_POLICY_CHUNKS,
      [],
    );
    expect(r.failedAsserts).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("still fails 'refund is on its way' with no tool call", () => {
    const r = verifyDraft(
      {
        answerText:
          "Your refund is on its way to your original payment method.",
        claims: [],
      },
      RETURN_POLICY_CHUNKS,
      [],
    );
    expect(r.passed).toBe(false);
    expect(r.failedAsserts.some((a) => a.startsWith("action_claim"))).toBe(
      true,
    );
  });

  it("still fails an unattested synonym ('processed') — the policy never says it", () => {
    // Deliberately conservative: "processed" appears in NO chunk, so the
    // draft prompt now nudges the model to use the policy's own verb
    // ("issued") instead. If the policy ever gains the word, this test
    // flips to passing on its own.
    const r = verifyDraft(
      {
        answerText:
          "Refunds are processed within 3 to 5 business days after inspection.",
        claims: [
          {
            text: "refunds issued 3 to 5 business days",
            chunkId: "supabase:returns:1",
            quote:
              "Approved refunds are issued to your original payment method within 3 to 5 business days after inspection.",
          },
        ],
      },
      RETURN_POLICY_CHUNKS,
      [],
    );
    expect(r.passed).toBe(false);
    expect(r.failedAsserts.some((a) => a.startsWith("action_claim"))).toBe(
      true,
    );
  });
});
