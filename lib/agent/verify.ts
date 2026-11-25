/**
 * Stage-2 post-generation verifier (architecture-v2.md §3.2).
 *
 * Pure code, deterministic, downgrade-only: it runs AFTER a draft is
 * generated and BEFORE anything streams to the user. It can only downgrade
 * (Answer/Caveat → Escalate); it never upgrades. Any assert failure
 * withholds the draft ENTIRELY — no partial answer, no "caveated" wrong
 * number.
 *
 * The draft is structured output: { answerText, claims[] }, where each
 * claim carries the chunk it came from and the exact quote supporting it.
 *
 * Asserts:
 * 1. Quote-substring: each claim's quote is a substring of the chunk
 *    identified by chunkId (chunk text fetched server-side, never trusted
 *    from the model). Comparison is whitespace-collapsed + case-insensitive
 *    so minor model formatting drift doesn't fail a true quote.
 * 2. Number assert: every number, day-count, and dollar amount in
 *    answerText appears in the retrieved chunks OR in the turn's tool
 *    results (refund amounts, order totals, order IDs come from tools, not
 *    chunks). Normalized: "60" matches "60-day" / "60 days"; "$129.00"
 *    matches "129.00".
 * 3. Action-claim assert: every claimed action in answerText must
 *    correspond to a record in the turn's toolCalls[]. A claimed action
 *    with no tool record fails. Claims with NO corresponding tool (e.g. a
 *    return label — no such tool exists) always fail, which makes them
 *    structurally impossible, not just editorially forbidden. EXCEPTION: a
 *    matched phrase that appears verbatim in a retrieved chunk is a
 *    restatement of policy, not a claim of action — "Refunds are issued
 *    within 3 to 5 business days" is in the Refund Timing chunk, so a
 *    draft repeating it must not fail. Only pairings the evidence never
 *    makes ("I've initiated your refund") are flagged.
 */

import type { RetrievalHit } from "@/lib/rag/retrieve";

export interface DraftClaim {
  text: string;
  chunkId: string;
  quote: string;
}

export interface Draft {
  answerText: string;
  claims: DraftClaim[];
}

export interface ToolCallForVerify {
  tool: string;
  /** "ok" | "business" | "system" — only successful calls substantiate claims. */
  outcome: "ok" | "business" | "system";
  /** Serialized tool result (for number extraction). */
  resultText: string;
}

export interface VerifyResult {
  passed: boolean;
  /** Named failing asserts, e.g. "quote_substring: claim 0". Empty when passed. */
  failedAsserts: string[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Extract numbers from text: integers and decimals, $ and commas stripped. */
export function extractNumbers(text: string): string[] {
  const matches = text.match(/\$?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((m) => m.replace(/[$,]/g, ""));
}

/**
 * Normalize a number for comparison: "129.00" and "129" are the same value;
 * "60" in "60-day" is just "60". Trailing ".00" is stripped, and a decimal
 * with a zero fraction collapses to its integer part.
 */
function normalizeNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  // Compare numerically: 129.00 === 129, 3.5 stays 3.5.
  return String(n);
}

// Action phrases and the tool that must have executed to substantiate them.
// `tool: null` means NO tool can substantiate the claim — it always fails.
const ACTION_CLAIMS: Array<{
  pattern: RegExp;
  tool: string | null;
  label: string;
}> = [
  {
    // Both word orders: "refund ... initiated" and "initiated ... refund".
    pattern: /\brefund\b.{0,40}\b(initiated|processed|started|on (its|the) way|issued|sent)\b|\b(initiated|processed|started|issued|sent)\b.{0,40}\brefund\b/i,
    tool: "initiateRefund",
    label: "refund initiated",
  },
  {
    pattern: /\b(return label|shipping label)\b.{0,40}\b(emailed|sent|on (its|the) way)\b/i,
    tool: null,
    label: "return label emailed/sent (no such tool exists)",
  },
  {
    pattern: /\bticket\b.{0,40}\b(created|opened|filed)\b/i,
    tool: "createTicket",
    label: "ticket created",
  },
  {
    pattern: /\b(replacement|new item)\b.{0,40}\b(shipped|sent|on (its|the) way)\b/i,
    tool: null,
    label: "replacement shipped (no such tool exists)",
  },
];

export function verifyDraft(
  draft: Draft,
  chunks: RetrievalHit[],
  toolCalls: ToolCallForVerify[],
): VerifyResult {
  const failedAsserts: string[] = [];
  const byId = new Map(chunks.map((c) => [c.chunkId, c.content]));

  // 1. Quote-substring assert.
  for (let i = 0; i < draft.claims.length; i++) {
    const claim = draft.claims[i];
    const chunkContent = byId.get(claim.chunkId);
    if (chunkContent === undefined) {
      failedAsserts.push(
        `quote_substring: claim ${i} cites unknown chunk ${claim.chunkId}`,
      );
      continue;
    }
    if (!normalize(chunkContent).includes(normalize(claim.quote))) {
      failedAsserts.push(
        `quote_substring: claim ${i} quote not found in chunk ${claim.chunkId}`,
      );
    }
  }

  // 2. Number assert — allowed numbers = chunks ∪ ok/business tool results.
  // Business outcomes are valid executions with real server-computed data
  // (e.g. the order ID the user gave in an ORDER_NOT_FOUND result) — they
  // count. Only "system" outcomes are excluded (no trustworthy data).
  const allowed = new Set<string>();
  for (const chunk of chunks) {
    for (const n of extractNumbers(chunk.content)) {
      allowed.add(normalizeNumber(n));
    }
  }
  for (const tc of toolCalls) {
    if (tc.outcome === "system") continue;
    for (const n of extractNumbers(tc.resultText)) {
      allowed.add(normalizeNumber(n));
    }
  }
  for (const n of extractNumbers(draft.answerText)) {
    const normalized = normalizeNumber(n);
    if (!allowed.has(normalized)) {
      failedAsserts.push(
        `number: ${n} in the answer does not appear in the retrieved chunks or tool results`,
      );
    }
  }

  // 3. Action-claim assert.
  const successfulTools = new Set(
    toolCalls.filter((tc) => tc.outcome === "ok").map((tc) => tc.tool),
  );
  for (const { pattern, tool, label } of ACTION_CLAIMS) {
    // Check every match, not just the first: a policy restatement early in
    // the answer must not mask a genuine action claim later in it.
    const globalPattern = new RegExp(pattern.source, "gi");
    let flagged = false;
    for (const m of draft.answerText.matchAll(globalPattern)) {
      // Verbatim in a retrieved chunk → restatement of policy, not an
      // action claim. (normalize = lowercase + collapse whitespace, same
      // as the quote-substring assert.)
      const matchedText = normalize(m[0]);
      const restatesPolicy = chunks.some((c) =>
        normalize(c.content).includes(matchedText),
      );
      if (restatesPolicy) continue;
      if (tool === null || !successfulTools.has(tool)) {
        flagged = true;
        break;
      }
    }
    if (flagged) {
      failedAsserts.push(
        `action_claim: answer claims "${label}" but no matching tool call executed`,
      );
    }
  }

  return { passed: failedAsserts.length === 0, failedAsserts };
}
