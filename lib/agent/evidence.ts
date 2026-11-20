/**
 * Stage-1 pre-generation gate (architecture-v2.md §3.1).
 *
 * Runs BEFORE generation, using retrieval evidence only — no draft exists
 * yet, so nothing circular is computed. The gate is intent-conditional:
 *
 * - policy_question / complaint: top-1 similarity bands (Answer ≥ 0.55,
 *   Caveat 0.40–0.55, Escalate < 0.40 or zero surviving chunks).
 * - refund: rules retrievable (any surviving chunk from the returns or
 *   billing policies) → proceed; otherwise escalate before any tool call.
 * - order_status / chit_chat / other: no retrieval gate (tool-answered or
 *   no policy claims); always proceeds.
 * - human_request / sensitive: never reaches Stage 1 — the graph routes
 *   them straight to escalate_node.
 *
 * All thresholds are PROVISIONAL (lib/agent/thresholds.ts) pending
 * calibration against the labeled eval set.
 */

import {
  STAGE1_ANSWER_MIN,
  STAGE1_CAVEAT_MIN,
} from "@/lib/agent/thresholds";
import type { Intent } from "@/lib/agent/model";
import type { RetrievalHit } from "@/lib/rag/retrieve";

export type EvidenceTrack = "answer" | "caveat" | "escalate";

export interface EvidenceCheck {
  track: EvidenceTrack;
  /** Top-1 similarity, or null when the intent has no retrieval gate. */
  topSimilarity: number | null;
  survivingChunks: number;
  intent: Intent;
  /** Human-readable reason for the drawer. */
  reason: string;
}

/** Policies that carry the refund rules (return window, eligibility). */
const REFUND_RULE_POLICIES = new Set(["returns", "billing"]);

export function stage1Gate(
  intent: Intent,
  hits: RetrievalHit[],
): EvidenceCheck {
  switch (intent) {
    case "policy_question":
    case "complaint": {
      if (hits.length === 0) {
        return {
          track: "escalate",
          topSimilarity: null,
          survivingChunks: 0,
          intent,
          reason: "No policy chunks survived the retrieval floor.",
        };
      }
      const top = hits[0].similarity;
      if (top >= STAGE1_ANSWER_MIN) {
        return {
          track: "answer",
          topSimilarity: top,
          survivingChunks: hits.length,
          intent,
          reason: `Top-1 similarity ${top.toFixed(2)} ≥ ${STAGE1_ANSWER_MIN} (answer track).`,
        };
      }
      if (top >= STAGE1_CAVEAT_MIN) {
        return {
          track: "caveat",
          topSimilarity: top,
          survivingChunks: hits.length,
          intent,
          reason: `Top-1 similarity ${top.toFixed(2)} is in the caveat band (${STAGE1_CAVEAT_MIN}–${STAGE1_ANSWER_MIN}); answer carries an explicit caveat.`,
        };
      }
      return {
        track: "escalate",
        topSimilarity: top,
        survivingChunks: hits.length,
        intent,
        reason: `Top-1 similarity ${top.toFixed(2)} < ${STAGE1_CAVEAT_MIN}; evidence too weak to answer.`,
      };
    }
    case "refund": {
      const ruleHits = hits.filter((h) =>
        REFUND_RULE_POLICIES.has(h.policySlug),
      );
      if (ruleHits.length === 0) {
        return {
          track: "escalate",
          topSimilarity: hits[0]?.similarity ?? null,
          survivingChunks: hits.length,
          intent,
          reason:
            "Refund rules (return window, eligibility) not retrievable — escalating before any tool call.",
        };
      }
      return {
        track: "answer",
        topSimilarity: ruleHits[0].similarity,
        survivingChunks: hits.length,
        intent,
        reason: "Refund rules retrieved; proceeding to tools.",
      };
    }
    case "order_status":
    case "chit_chat":
    case "other":
      return {
        track: "answer",
        topSimilarity: null,
        survivingChunks: hits.length,
        intent,
        reason: "Intent has no retrieval gate.",
      };
    case "human_request":
    case "sensitive":
      // Defensive: the graph routes these to escalate_node before pre_gate.
      return {
        track: "escalate",
        topSimilarity: null,
        survivingChunks: hits.length,
        intent,
        reason: "Human request / sensitive topic — always escalates.",
      };
  }
}

/** Caveat prefix for the Caveat track (§3.1): answer + explicit caveat + offer human. */
export const CAVEAT_PREFIX =
  "I want to flag that I'm answering from our policies but the match wasn't strong — please double-check this, and I'm happy to connect you with a human agent if you'd like. ";
