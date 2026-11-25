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
 *    matched phrase whose (noun, verb) pairing is attested in a retrieved
 *    chunk is a restatement of policy, not a claim of action — "Refunds
 *    are issued within 3 to 5 business days" restates the Refund Timing
 *    chunk, so a draft repeating it must not fail. Only pairings the
 *    evidence never makes ("I've initiated your refund", "refund on its
 *    way") are flagged. A verbatim-substring exemption is NOT enough:
 *    the regex spans sentence boundaries ("refund or replacement.
 *    Refunds are issued") and the model paraphrases ("will be issued
 *    instead of a refund"), so verbatim almost never fires on real
 *    model output — the pairing check is what actually exempts
 *    restatements.
 */

import type { RetrievalHit } from "@/lib/rag/retrieve";
import { tokenize } from "@/lib/rag/text";

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
    // `refunds?` (not just `refund`): policy descriptions use the plural
    // ("Refunds are issued"), and a plural action claim ("Refunds are
    // initiated") must match too — attestation, not the regex, decides
    // whether the match is a restatement.
    pattern: /\brefunds?\b.{0,40}\b(initiated|processed|started|on (its|the) way|issued|sent)\b|\b(initiated|processed|started|issued|sent)\b.{0,40}\brefunds?\b/i,
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

// Nouns and verbs that make an action phrase, stemmed via the shared
// tokenize() so "refunds" matches "refund" and "issued" matches "issue".
// Used by the attestation check below: a matched phrase is a policy
// restatement when its (noun, verb) pairing is attested in a retrieved
// chunk. "way" covers the "on its way" / "on the way" phrasings
// (tokenize drops "on"/"its"/"the" as stopwords, leaving "way").
const ACTION_NOUNS = new Set(
  ["refund", "label", "ticket", "replacement", "item"].flatMap((w) =>
    tokenize(w),
  ),
);
const ACTION_VERBS = new Set(
  [
    "initiated",
    "processed",
    "started",
    "issued",
    "sent",
    "emailed",
    "shipped",
    "created",
    "opened",
    "filed",
    "arriving",
    "way",
  ].flatMap((w) => tokenize(w)),
);

/**
 * True when the matched action phrase is a restatement of policy: EVERY
 * action verb in the span is attested in some retrieved chunk together
 * with an action noun from the same span. "Every" matters — a span that
 * pairs an attested verb with an unattested one ("refund was initiated
 * and will be issued") is still a claim. A verb the policy never uses
 * ("initiated", "processed", "started", "sent", "emailed", "on its
 * way") cannot be attested, so a draft claiming it still fails — as it
 * should. In this corpus the attested verbs are "issued" (Refund Timing)
 * and "shipped" (order cancellation); the rest are unattested by design.
 */
function restatesPolicy(
  matchedText: string,
  chunkTokenSets: Array<Set<string>>,
): boolean {
  const matchTokens = new Set(tokenize(matchedText));
  const nouns = [...matchTokens].filter((t) => ACTION_NOUNS.has(t));
  const verbs = [...matchTokens].filter((t) => ACTION_VERBS.has(t));
  if (nouns.length === 0 || verbs.length === 0) return false;
  return verbs.every((verb) =>
    chunkTokenSets.some(
      (chunkTokens) =>
        chunkTokens.has(verb) &&
        nouns.some((noun) => chunkTokens.has(noun)),
    ),
  );
}

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
  // Token sets of the retrieved chunks, computed once: the attestation
  // check is a set-membership test per match, not a substring scan.
  const chunkTokenSets = chunks.map((c) => new Set(tokenize(c.content)));
  for (const { pattern, tool, label } of ACTION_CLAIMS) {
    // Check every match, not just the first: a policy restatement early in
    // the answer must not mask a genuine action claim later in it.
    const globalPattern = new RegExp(pattern.source, "gi");
    let flagged = false;
    for (const m of draft.answerText.matchAll(globalPattern)) {
      // (noun, verb) attested in a retrieved chunk → restatement of
      // policy, not a claim that an action was taken.
      if (restatesPolicy(m[0], chunkTokenSets)) continue;
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
