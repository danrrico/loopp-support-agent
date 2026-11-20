/**
 * Tool argument schemas (architecture-v2.md §5.2).
 *
 * Every tool argument is validated with zod BEFORE execution; a validation
 * failure is a SYSTEM error (counts toward the two-error trigger) and is
 * logged with the offending args. Business outcomes (ORDER_NOT_FOUND,
 * REFUND_NOT_ELIGIBLE) are NOT validation failures — they are valid
 * executions with a business result.
 *
 * The model sees exactly three tools: orderLookup, initiateRefund,
 * searchKnowledgeBase. `createTicket` is NOT model-callable — it lives in
 * `escalate_node` only (its schema is here for the node, not for the model).
 */

import { z } from "zod";

const ORDER_ID_RE = /^NW-\d{5}$/i;

/** Normalize an order ID: trim + uppercase. */
function normalizeOrderId(id: string): string {
  return id.trim().toUpperCase();
}

export const orderLookupSchema = z
  .object({
    orderId: z
      .string()
      .transform(normalizeOrderId)
      .pipe(z.string().regex(ORDER_ID_RE, "orderId must look like NW-88412"))
      .optional(),
    email: z.string().email("email must be a valid email address").optional(),
  })
  .refine((args) => args.orderId !== undefined || args.email !== undefined, {
    message: "orderLookup requires orderId or email (at least one)",
  });

export type OrderLookupArgs = z.infer<typeof orderLookupSchema>;

export const initiateRefundSchema = z.object({
  orderId: z
    .string()
    .transform(normalizeOrderId)
    .pipe(z.string().regex(ORDER_ID_RE, "orderId must look like NW-88412")),
  reason: z.string().min(1).max(500),
  /** Present only in phase 2 (after user confirmation). */
  confirmationToken: z.string().uuid().optional(),
});

export type InitiateRefundArgs = z.infer<typeof initiateRefundSchema>;

export const searchKnowledgeBaseSchema = z.object({
  query: z.string().min(1).max(500),
  topK: z.number().int().min(1).max(5).default(3),
});

export type SearchKnowledgeBaseArgs = z.infer<typeof searchKnowledgeBaseSchema>;

/** Escalate-node only — never exposed to the model. */
export const createTicketSchema = z.object({
  subject: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  summary: z.string().min(1).max(2000),
});

export type CreateTicketArgs = z.infer<typeof createTicketSchema>;
