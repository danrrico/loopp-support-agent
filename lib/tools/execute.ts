/**
 * Tool execution (architecture-v2.md §5.2, §5.3).
 *
 * Tools are plain functions + zod schemas, called by the graph's tools_loop
 * node. The OpenAI-compatible model receives their JSON schemas for native
 * tool-calling; the mock model emits the same call shapes by rule. Either
 * way, execution goes through this module — the model never touches the DB.
 *
 * Outcomes:
 * - "ok": the tool ran and produced a result.
 * - "business": a valid execution with a business result (ORDER_NOT_FOUND,
 *   REFUND_NOT_ELIGIBLE, REFUND_OVER_LIMIT). Reported to the user; does NOT
 *   count toward the two-error escalation trigger and does NOT consume
 *   retries.
 * - "system": DB error, timeout, validation failure, unexpected exception.
 *   Counts toward the trigger, keyed on hash(tool, args).
 *
 * Money is integer cents everywhere. Amounts are computed in code, never
 * taken from model arguments — `initiateRefund` has NO amount field.
 */

import { randomUUID } from "node:crypto";
import {
  REFUND_AUTO_MAX_CENTS,
  RETURN_WINDOW_DAYS,
} from "@/lib/agent/thresholds";
import type { ToolDefinition } from "@/lib/agent/model";
import type { SessionStore } from "@/lib/db/store";
import { formatCents, refundDisplayId } from "@/lib/money";
import { retrieve } from "@/lib/rag/retrieve";
import {
  initiateRefundSchema,
  orderLookupSchema,
  searchKnowledgeBaseSchema,
  type InitiateRefundArgs,
  type OrderLookupArgs,
  type SearchKnowledgeBaseArgs,
} from "@/lib/tools/schemas";

export type ToolOutcome = "ok" | "business" | "system";

export interface ToolResult {
  outcome: ToolOutcome;
  /** Structured result (serialized for the drawer + verifier). */
  data: Record<string, unknown>;
  /** Machine-readable error code for business/system outcomes. */
  errorCode?: string;
  /** Human-readable error detail (system outcomes only — never shown raw to the user). */
  errorDetail?: string;
}

export const MODEL_TOOLS: ToolDefinition[] = [
  {
    name: "orderLookup",
    description:
      "Look up an order by order ID (like NW-88412) or by the email address on the order. At least one of orderId or email is required. Returns the order's status, items, and totals, or ORDER_NOT_FOUND.",
    parameters: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "Order ID, e.g. NW-88412",
        },
        email: {
          type: "string",
          description: "Email address on the order",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "initiateRefund",
    description:
      "Start a refund for a delivered order. The amount is computed by the system from the order — do NOT pass an amount. Phase 1 (no confirmationToken) proposes the refund and returns REQUIRES_CONFIRMATION with the exact amount; the user must confirm before anything executes. Phase 2 (with the confirmationToken from the pending confirmation) executes it.",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "Order ID, e.g. NW-88412" },
        reason: {
          type: "string",
          description: "Why the customer wants the refund",
        },
        confirmationToken: {
          type: "string",
          description:
            "Only when the user has confirmed a pending refund proposal — the token from that proposal.",
        },
      },
      required: ["orderId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "searchKnowledgeBase",
    description:
      "Search the Northwind Outfitters policy knowledge base for a refined query. Returns matching policy sections with relevance scores. Use when the already-retrieved policy text does not cover the question.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        topK: {
          type: "integer",
          description: "Max results (1–5, default 3)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

/** Tool execution context — everything a tool needs, supplied by the graph. */
export interface ToolContext {
  store: SessionStore;
  sessionId: string;
  turnNumber: number;
  /** The pending refund confirmation, if one exists (phase-2 validation). */
  pendingConfirmationToken?: string;
}

function systemError(tool: string, err: unknown): ToolResult {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[tool:${tool}] system failure: ${detail}`);
  return {
    outcome: "system",
    data: {},
    errorCode: "SYSTEM_ERROR",
    errorDetail: detail,
  };
}

/** Refund eligibility, computed in code from the order row (§5.3). */
export function checkRefundEligibility(order: {
  status: string;
  placedAt: string;
  totalCents: number;
  refundedCents: number;
}): { eligible: true; amountCents: number } | { eligible: false; reason: string } {
  if (order.status !== "delivered") {
    return {
      eligible: false,
      reason: `Order is ${order.status}, not delivered — only delivered orders can be refunded.`,
    };
  }
  const placedAt = new Date(order.placedAt).getTime();
  const windowEnd = placedAt + RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (Date.now() > windowEnd) {
    return {
      eligible: false,
      reason: `Order was placed more than ${RETURN_WINDOW_DAYS} days ago — outside the return window.`,
    };
  }
  const amountCents = order.totalCents - order.refundedCents;
  if (amountCents <= 0) {
    return {
      eligible: false,
      reason: "This order has already been fully refunded.",
    };
  }
  return { eligible: true, amountCents };
}

export async function executeOrderLookup(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = orderLookupSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      outcome: "system",
      data: {},
      errorCode: "VALIDATION_ERROR",
      errorDetail: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  const args: OrderLookupArgs = parsed.data;
  try {
    if (args.orderId) {
      const order = await ctx.store.getOrder(args.orderId);
      if (!order) {
        return {
          outcome: "business",
          data: { error: "ORDER_NOT_FOUND", orderId: args.orderId },
          errorCode: "ORDER_NOT_FOUND",
        };
      }
      return {
        outcome: "ok",
        data: {
          orderId: order.orderId,
          email: order.email,
          status: order.status,
          items: order.items,
          totalCents: order.totalCents,
          totalDisplay: formatCents(order.totalCents),
          refundedCents: order.refundedCents,
          refundableCents: order.totalCents - order.refundedCents,
          refundableDisplay: formatCents(
            order.totalCents - order.refundedCents,
          ),
          placedAt: order.placedAt,
          trackingNumber: order.trackingNumber,
          carrier: order.carrier,
          estimatedDelivery: order.estimatedDelivery,
        },
      };
    }
    // Email lookup: bounded (max 5 shown), never auto-picks (§5.2).
    const orders = await ctx.store.getOrdersByEmail(args.email!, 5);
    if (orders.length === 0) {
      return {
        outcome: "business",
        data: { error: "ORDER_NOT_FOUND", email: args.email },
        errorCode: "ORDER_NOT_FOUND",
      };
    }
    return {
      outcome: "ok",
      data: {
        orders: orders.map((o) => ({
          orderId: o.orderId,
          status: o.status,
          totalCents: o.totalCents,
          totalDisplay: formatCents(o.totalCents),
          placedAt: o.placedAt,
          itemSummary: o.items.map((i) => `${i.name} (×${i.qty})`).join(", "),
        })),
        count: orders.length,
        needsDisambiguation: orders.length > 1,
      },
    };
  } catch (err) {
    return systemError("orderLookup", err);
  }
}

export async function executeInitiateRefund(
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = initiateRefundSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      outcome: "system",
      data: {},
      errorCode: "VALIDATION_ERROR",
      errorDetail: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  const args: InitiateRefundArgs = parsed.data;
  try {
    const order = await ctx.store.getOrder(args.orderId);
    if (!order) {
      return {
        outcome: "business",
        data: { error: "ORDER_NOT_FOUND", orderId: args.orderId },
        errorCode: "ORDER_NOT_FOUND",
      };
    }

    // Phase 2 — execute. Idempotency is checked BEFORE eligibility: after
    // a successful execution the order is fully refunded, so a naive
    // re-check would reject the retry as NOT_ELIGIBLE. A retry with the
    // same key returns the stored outcome instead of re-executing (§5.5).
    if (args.confirmationToken) {
      const idempotencyKey = `${ctx.sessionId}:${ctx.turnNumber}:${args.confirmationToken}`;
      const existing = await ctx.store.getRefundByKey(
        args.orderId,
        idempotencyKey,
      );
      if (existing) {
        return {
          outcome: "ok",
          data: {
            status: "initiated",
            refundId: refundDisplayId(existing.id),
            refundDbId: existing.id,
            orderId: existing.orderId,
            amountCents: existing.amountCents,
            amountDisplay: formatCents(existing.amountCents),
          },
        };
      }
    }

    const eligibility = checkRefundEligibility(order);
    if (!eligibility.eligible) {
      return {
        outcome: "business",
        data: {
          error: "REFUND_NOT_ELIGIBLE",
          orderId: args.orderId,
          reason: eligibility.reason,
        },
        errorCode: "REFUND_NOT_ELIGIBLE",
      };
    }

    // Phase 1 — propose. No side effect; returns a confirmation token.
    if (!args.confirmationToken) {
      return {
        outcome: "ok",
        data: {
          status: "REQUIRES_CONFIRMATION",
          confirmationToken: randomUUID(),
          orderId: args.orderId,
          amountCents: eligibility.amountCents,
          amountDisplay: formatCents(eligibility.amountCents),
          reason: args.reason,
        },
      };
    }

    // Phase 2 — execute. The token must match the pending confirmation the
    // graph stored — a model-invented token never executes (§1.4: the model
    // is untrusted for side effects).
    if (args.confirmationToken !== ctx.pendingConfirmationToken) {
      return {
        outcome: "system",
        data: {},
        errorCode: "VALIDATION_ERROR",
        errorDetail: "confirmationToken does not match the pending refund",
      };
    }

    // Over $500: after confirmation, route to escalation for human approval
    // instead of auto-executing (§3.5 trigger 8). The graph sees
    // REFUND_OVER_LIMIT and routes to escalate_node.
    if (eligibility.amountCents > REFUND_AUTO_MAX_CENTS) {
      return {
        outcome: "business",
        data: {
          error: "REFUND_OVER_LIMIT",
          orderId: args.orderId,
          amountCents: eligibility.amountCents,
          amountDisplay: formatCents(eligibility.amountCents),
          reason: `Refunds over $${(REFUND_AUTO_MAX_CENTS / 100).toFixed(0)} need human approval.`,
        },
        errorCode: "REFUND_OVER_LIMIT",
      };
    }

    // Re-validated eligibility + balance above; execute atomically with an
    // idempotency key derived from (sessionId, turn_number, token).
    const idempotencyKey = `${ctx.sessionId}:${ctx.turnNumber}:${args.confirmationToken}`;
    const result = await ctx.store.executeRefund({
      orderId: args.orderId,
      idempotencyKey,
      amountCents: eligibility.amountCents,
      reason: args.reason,
      sessionId: ctx.sessionId,
    });
    if ("error" in result) {
      return {
        outcome: "business",
        data: {
          error: result.error,
          orderId: args.orderId,
          reason:
            result.error === "OVER_BALANCE"
              ? "The refundable balance changed — the order no longer has enough remaining balance for this refund."
              : "The order could not be found.",
        },
        errorCode: result.error,
      };
    }
    return {
      outcome: "ok",
      data: {
        status: "initiated",
        refundId: refundDisplayId(result.refund.id),
        refundDbId: result.refund.id,
        orderId: result.refund.orderId,
        amountCents: result.refund.amountCents,
        amountDisplay: formatCents(result.refund.amountCents),
      },
    };
  } catch (err) {
    return systemError("initiateRefund", err);
  }
}

export async function executeSearchKnowledgeBase(
  rawArgs: unknown,
): Promise<ToolResult> {
  const parsed = searchKnowledgeBaseSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      outcome: "system",
      data: {},
      errorCode: "VALIDATION_ERROR",
      errorDetail: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  const args: SearchKnowledgeBaseArgs = parsed.data;
  try {
    // Same retrieve() as the graph — same scores, same floor (§5.2).
    const { hits } = await retrieve(args.query, { topK: args.topK });
    return {
      outcome: "ok",
      data: {
        results: hits.map((h) => ({
          title: `${h.policySlug} — ${h.section}`,
          excerpt: h.content.slice(0, 300),
          policySlug: h.policySlug,
          score: h.similarity,
          source: h.source,
        })),
      },
    };
  } catch (err) {
    return systemError("searchKnowledgeBase", err);
  }
}

/** Dispatch by tool name. Unknown tool names are a system error. */
export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "orderLookup":
      return executeOrderLookup(args, ctx);
    case "initiateRefund":
      return executeInitiateRefund(args, ctx);
    case "searchKnowledgeBase":
      return executeSearchKnowledgeBase(args);
    default:
      return {
        outcome: "system",
        data: {},
        errorCode: "UNKNOWN_TOOL",
        errorDetail: `No such tool: ${name}`,
      };
  }
}
