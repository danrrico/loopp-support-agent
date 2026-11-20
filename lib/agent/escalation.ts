/**
 * Escalation triggers + escalate_node (architecture-v2.md §3.5).
 *
 * Escalation is a DETERMINISTIC system node, not a model decision and not
 * a model-callable tool. Any one trigger fires it:
 *
 * 1. stage1_fail — insufficient retrieval evidence (policy/refund intent)
 * 2. stage2_fail — a verifier assert failed; draft withheld
 * 3. sensitive_topic — legal/fraud/injury/compromise/medical (detected in
 *    the routing call). EXCEPTION: requests for another customer's data
 *    are REFUSED, not escalated — no ticket containing the requested data
 *    is created.
 * 4. explicit_request — user asked for a human
 * 5. repeated_failure — 2 consecutive Caveat turns, OR the user re-asks
 *    the same question (embedding similarity > 0.85) with an explicit
 *    "that didn't help" signal. No sentiment model call.
 * 6. tool_system_failure — 2 system failures for the same request
 * 7. tool_budget_exhausted — the 3-iteration tool cap was hit
 * 8. refund_over_500 — after confirmation, refund > $500 needs approval
 *
 * What escalate_node does: creates exactly one ticket (idempotency key
 * (sessionId, turn_number), unique constraint — retries cannot duplicate
 * it), attaches a sanitized handoff summary + the evidence-check trace,
 * sets sessions.escalated = true server-side (later turns return the
 * handoff message, they do not silently resume answering), posts the
 * handoff message. If ticket creation itself fails, it retries once, then
 * persists a `pending` handoff record and tells the user honestly that the
 * handoff is queued — it never claims a handoff that does not exist.
 */

import { REASK_SIMILARITY } from "@/lib/agent/thresholds";
import type { EvidenceTrack } from "@/lib/agent/evidence";
import type { SensitiveCategory } from "@/lib/agent/model";
import type { SessionStore } from "@/lib/db/store";
import { cosineSimilarity, type Embedder } from "@/lib/rag/embeddings";
import { redactPII } from "@/lib/trace";

export type EscalationRule =
  | "stage1_fail"
  | "stage2_fail"
  | "sensitive_topic"
  | "explicit_request"
  | "repeated_failure"
  | "tool_system_failure"
  | "tool_budget_exhausted"
  | "refund_over_500";

export const ESCALATION_RULE_LABELS: Record<EscalationRule, string> = {
  stage1_fail: "Insufficient policy evidence to answer confidently",
  stage2_fail: "Draft failed verification — withheld, not shown",
  sensitive_topic: "Sensitive topic needs a human agent",
  explicit_request: "Customer asked for a human agent",
  repeated_failure: "Repeated unsuccessful attempts to answer",
  tool_system_failure: "System errors prevented completing the request",
  tool_budget_exhausted: "Tool budget exhausted before the request completed",
  refund_over_500: "Refund over $500 needs human approval",
};

/** User-facing handoff message per rule. */
export function buildHandoffMessage(
  rule: EscalationRule,
  detail?: string,
): string {
  switch (rule) {
    case "sensitive_topic":
      return "This needs a human agent — I've opened a ticket and our support team will follow up with you shortly. Thank you for your patience.";
    case "explicit_request":
      return "Of course — I've opened a ticket for a human agent, who will follow up with you shortly. Thank you for your patience.";
    case "refund_over_500":
      return "Your refund request is confirmed, but refunds over $500 need approval from a human agent. I've opened a ticket with your confirmed request attached — our team will review it and follow up shortly.";
    case "tool_budget_exhausted":
      return "I'm having trouble completing that request — I've opened a ticket with everything I've found so far, and a human agent will pick it up from here.";
    case "stage2_fail":
      return "I want to make sure you get an accurate answer, so I've handed this to a human agent. I've opened a ticket and our support team will follow up shortly.";
    default:
      return (
        "I don't have enough information to answer that confidently, so I've " +
        "opened a ticket for a human agent, who will follow up with you shortly. " +
        (detail ? `${detail} ` : "") +
        "Thank you for your patience."
      );
  }
}

/** Refusal for requests for another customer's data — no ticket, no escalation. */
export const OTHER_CUSTOMER_DATA_REFUSAL =
  "I can't share another customer's order or account information — that's protected for their privacy. If you need help with your own order, I'm happy to look it up with your order number or email address.";

export interface EscalateInput {
  store: SessionStore;
  sessionId: string;
  turnNumber: number;
  rule: EscalationRule;
  /** Sensitive category, when the rule is sensitive_topic. */
  sensitiveCategory?: SensitiveCategory | null;
  /** Sanitized handoff summary for the ticket (user-typed text only, no tool payloads). */
  summary: string;
  /** Evidence-check outcome to attach to the ticket. */
  evidenceSummary?: string;
}

export interface EscalateResult {
  ticketId: string | null;
  /** True when ticket creation failed twice and the handoff is queued. */
  handoffPending: boolean;
  handoffMessage: string;
}

export async function runEscalateNode(
  input: EscalateInput,
): Promise<EscalateResult> {
  const handoffMessage = buildHandoffMessage(input.rule);
  const summary = redactPII(
    `${input.summary}${input.evidenceSummary ? `\n\nEvidence check: ${input.evidenceSummary}` : ""}`,
  ) as string;

  let ticketId: string | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ticket = await input.store.createTicket({
        sessionId: input.sessionId,
        turnNumber: input.turnNumber,
        subject: `Escalation: ${ESCALATION_RULE_LABELS[input.rule]}`,
        category: input.sensitiveCategory ?? input.rule,
        priority: input.rule === "sensitive_topic" ? "high" : "medium",
        summary,
      });
      ticketId = ticket.id;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!ticketId) {
    console.error(
      `[escalate] ticket creation failed twice for session ${input.sessionId} turn ${input.turnNumber}:`,
      lastError,
    );
  }

  // Mark the session escalated server-side regardless — later turns return
  // the handoff message, they do not silently resume answering.
  try {
    await input.store.setSessionEscalated(input.sessionId);
  } catch (err) {
    console.error(
      `[escalate] setSessionEscalated failed for ${input.sessionId}:`,
      err,
    );
  }

  if (!ticketId) {
    return {
      ticketId: null,
      handoffPending: true,
      handoffMessage:
        "I need to hand this to a human agent, and the handoff is queued — our team will pick it up as soon as the ticket system is back. Thank you for your patience.",
    };
  }
  return { ticketId, handoffPending: false, handoffMessage };
}

// ---------------------------------------------------------------------------
// Repeated-failure detection (trigger 5)
// ---------------------------------------------------------------------------

const NEGATIVE_SIGNALS =
  /\b(didn'?t help|not helpful|doesn'?t answer|still don'?t (understand|get it)|that'?s wrong|no,? i mean|you'?re not (helping|listening)|useless|again\?)\b/i;

export async function checkRepeatedFailure(opts: {
  /** Evidence tracks of the last turns (most recent last). */
  recentTracks: EvidenceTrack[];
  /** Last two user messages (most recent last) — for re-ask detection. */
  lastUserMessages: string[];
  currentMessage: string;
  embedder: Embedder;
}): Promise<{ repeated: boolean; reason: string | null }> {
  const lastTwo = opts.recentTracks.slice(-2);
  if (
    lastTwo.length === 2 &&
    lastTwo[0] === "caveat" &&
    lastTwo[1] === "caveat"
  ) {
    return {
      repeated: true,
      reason: "Two consecutive turns in the Caveat track.",
    };
  }

  const previous = opts.lastUserMessages[opts.lastUserMessages.length - 1];
  if (previous && NEGATIVE_SIGNALS.test(opts.currentMessage)) {
    // Compare the QUESTION content, not the complaint wrapper: strip the
    // negative-signal phrase before embedding, or its words dilute the
    // similarity below the threshold.
    const questionOnly = opts.currentMessage.replace(NEGATIVE_SIGNALS, "");
    const [a, b] = await opts.embedder.embed([previous, questionOnly]);
    const similarity = cosineSimilarity(a, b);
    if (similarity > REASK_SIMILARITY) {
      return {
        repeated: true,
        reason: `User re-asked the same question (similarity ${similarity.toFixed(2)}) with a negative signal.`,
      };
    }
  }
  return { repeated: false, reason: null };
}
