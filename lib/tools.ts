/**
 * Mock support tools for the Loopp Support Agent.
 *
 * These are stubs for the assessment: they return canned data so the agent
 * flow (retrieval → tool call → reply) can be built and demoed end to end
 * without a real order/refund/ticketing backend.
 *
 * TODO (build phase): convert these into LangChain `tool()` definitions
 * (from `@langchain/core/tools`) and bind them to the LangGraph agent.
 * Keep the same names and argument shapes so the agent prompts and the
 * observability drawer don't change.
 */

/** Look up an order by ID. Returns mock order status + items. */
export async function orderLookup(args: { orderId: string }): Promise<{
  orderId: string;
  status: string;
  items: string[];
  totalUsd: number;
}> {
  // TODO: replace canned data with a real lookup (or a richer mock dataset).
  return {
    orderId: args.orderId,
    status: "shipped",
    items: ["Widget Pro (×1)", "Widget Case (×1)"],
    totalUsd: 129.98,
  };
}

/** Start a refund for an order. Returns a mock refund confirmation. */
export async function initiateRefund(args: {
  orderId: string;
  reason: string;
}): Promise<{ refundId: string; orderId: string; status: string }> {
  // TODO: wire to a real refunds flow (or a richer mock with idempotency).
  return {
    refundId: `rf_${args.orderId}`,
    orderId: args.orderId,
    status: "initiated",
  };
}

/** Create a support ticket for human follow-up. Returns a mock ticket ID. */
export async function createTicket(args: {
  subject: string;
  description: string;
  priority?: "low" | "medium" | "high";
}): Promise<{ ticketId: string; subject: string; priority: string }> {
  // TODO: wire to a real ticketing system (or persist tickets in Supabase).
  return {
    ticketId: `tk_${Date.now()}`,
    subject: args.subject,
    priority: args.priority ?? "medium",
  };
}
