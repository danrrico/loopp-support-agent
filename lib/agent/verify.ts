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
 * 1. Quote grounding: each claim's quote must be grounded in the
 *    retrieved chunks — verbatim in the cited chunk, verbatim in ANY
 *    retrieved chunk (the model sometimes cites the wrong chunkId), or
 *    a ≥85% token-overlap fuzzy match in one chunk (a word/punctuation
 *    drift, not a fabrication). Comparison is whitespace-collapsed +
 *    case-insensitive so minor model formatting drift doesn't fail a
 *    true quote. A quote matching nothing is still fabrication and fails.
 *    (Chunk text is fetched server-side, never trusted from the model.)
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
 * True when a claim's quote is grounded in the retrieved evidence, in
 * three tiers of increasing tolerance. The model is instructed to copy
 * quotes verbatim, and usually does — but it sometimes cites the wrong
 * chunkId for a real quote, or drifts a word/punctuation mark. Withholding
 * a correct answer over a mislabeled or slightly drifted quote is a false
 * positive; the number and action-claim asserts still guard the answer
 * text itself. A quote that matches nothing is still fabrication and
 * fails. Tier 1: verbatim in the cited chunk. Tier 2: verbatim in ANY
 * retrieved chunk (wrong chunkId — the evidence is real, the citation
 * was mislabeled). Tier 3: fuzzy — at least 85% of the quote's content
 * tokens (stemmed, stopwords dropped, via the shared tokenize) appear in
 * a single chunk, AND every number in the quote appears in that same
 * chunk (a wrong number must not be rescued by overlap alone, since the
 * number assert only checks that the number appears somewhere in the
 * corpus). Quotes under 3 content tokens need an exact match — there is
 * too little signal to fuzzy-match them.
 */
function quoteIsGrounded(
  quote: string,
  citedContent: string,
  chunks: RetrievalHit[],
  chunkTokenSets: Array<Set<string>>,
): boolean {
  const normalizedQuote = normalize(quote);
  if (!normalizedQuote) return false;
  // Tier 1: verbatim in the cited chunk.
  if (normalize(citedContent).includes(normalizedQuote)) return true;
  // Tier 2: verbatim in any retrieved chunk (wrong chunkId).
  if (
    chunks.some((c) => normalize(c.content).includes(normalizedQuote))
  ) {
    return true;
  }
  // Tier 3: fuzzy — ≥85% of the quote's content tokens in one chunk,
  // AND every number in the quote appears in that SAME chunk. The number
  // guard matters: a wrong number ("30 days" for the 60-day window) has
  // 9/10 tokens matching the right chunk, so overlap alone would rescue
  // it — and the number assert cannot catch it, because "30" appears
  // elsewhere in the corpus (the defective chunk). Numbers must be
  // attested in the same chunk as the rest of the quote.
  const quoteTokens = tokenize(quote);
  if (quoteTokens.length < 3) return false;
  const quoteSet = new Set(quoteTokens);
  const quoteNumbers = extractNumbers(quote).map(normalizeNumber);
  return chunkTokenSets.some((chunkTokens, idx) => {
    let hits = 0;
    for (const t of quoteSet) {
      if (chunkTokens.has(t)) hits++;
    }
    if (hits / quoteSet.size < 0.85) return false;
    if (quoteNumbers.length > 0) {
      const chunkNumbers = new Set(
        extractNumbers(chunks[idx].content).map(normalizeNumber),
      );
      if (!quoteNumbers.every((n) => chunkNumbers.has(n))) return false;
    }
    return true;
  });
}

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
 *
 * Attestation alone does not establish generic policy voice: "Your
 * refund has been issued" pairs an attested (refund, issued) with a
 * customer-specific claim — it asserts THIS user's refund was issued.
 * A perfect-tense verb ("has/have been issued") marks the span as
 * customer-specific, so attestation does not exempt it; only a tool
 * call can substantiate it. (A bare possessive "your" is NOT a marker
 * — policy answers use "your" generically, e.g. "issued to your
 * original payment method", which the chunks themselves say.)
 */
function restatesPolicy(
  matchedText: string,
  chunkTokenSets: Array<Set<string>>,
): boolean {
  // Perfect tense = the action already happened for this customer.
  if (
    /\b(has|have)\s+been\s+(initiated|processed|started|issued|sent|emailed|shipped|created|opened|filed)\b/i.test(
      matchedText,
    )
  ) {
    return false;
  }
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
  // Token sets of the retrieved chunks, computed once: the attestation
  // (assert 3) and fuzzy-quote (assert 1) checks are set-membership
  // tests per claim/match, not substring scans.
  const chunkTokenSets = chunks.map((c) => new Set(tokenize(c.content)));

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
    if (quoteIsGrounded(claim.quote, chunkContent, chunks, chunkTokenSets)) {
      continue;
    }
    failedAsserts.push(
      `quote_substring: claim ${i} quote not found in chunk ${claim.chunkId}`,
    );
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
