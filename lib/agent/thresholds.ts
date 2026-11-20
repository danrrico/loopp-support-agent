/**
 * Provisional thresholds (architecture-v2.md §3.1, §3.4).
 *
 * ALL of these are starting points for the build, not claims about the
 * corpus. The calibration eval (scripts/eval-retrieval.ts over
 * data/eval-questions.json) sets the real values from measured similarity
 * distributions, and the measured numbers are recorded in the eval file +
 * README. If the distributions show no clean gap, the thresholds stay
 * conservative (escalate more) and the README says so honestly.
 *
 * Single source of truth: every gate, retriever, and eval script imports
 * from here — no threshold is hard-coded anywhere else.
 */

/** Similarity floor: chunks below this are dropped from retrieval results. */
export const RETRIEVAL_FLOOR = 0.3;

/** Stage-1 band edges (top-1 similarity, policy/complaint intents). */
export const STAGE1_ANSWER_MIN = 0.55;
export const STAGE1_CAVEAT_MIN = 0.4;

/** Re-ask detection: last two user messages more similar than this counts
 *  as the user re-asking the same question (with an explicit negative
 *  signal, it escalates — §3.5 trigger 5). */
export const REASK_SIMILARITY = 0.85;

/** Refunds above this amount (integer cents) route to escalation for human
 *  approval after user confirmation instead of auto-executing (§5.3). */
export const REFUND_AUTO_MAX_CENTS = 50_000; // $500.00

/** Return window in days (returns policy). Refund eligibility is computed
 *  in code from the order's placed_at + this window. */
export const RETURN_WINDOW_DAYS = 60;

/** Max tool iterations per turn. Cap exhaustion emits
 *  `tool_budget_exhausted` and routes to escalation — never generate_answer. */
export const TOOL_MAX_ITERATIONS = 3;

/** System failures (not business outcomes) for the same request that
 *  trigger escalation, keyed on hash(tool, args). */
export const SYSTEM_FAILURE_ESCALATION_COUNT = 2;
