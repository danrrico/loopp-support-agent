/**
 * Session store interface + factory (architecture-v2.md §5.5, §7).
 *
 * All side-effect state lives behind this interface. Two implementations:
 * - Supabase (`lib/db/supabase-store.ts`) when the env vars are set.
 * - In-memory demo store (`lib/db/memory-store.ts`) when they are not —
 *   seeded from data/mock-orders.json at first use. Demo state does not
 *   survive a restart or cross Vercel instances; the README says so.
 *
 * Turn serialization (§5.1): optimistic concurrency on `sessions.version`.
 * `saveSessionState` throws `VersionConflictError` when the expected
 * version no longer matches — the route retries the turn from its start
 * (restart-at-turn-boundary; tool effects are not re-executed thanks to
 * idempotency keys).
 */

import type { TraceEvent } from "@/lib/trace";

export interface OrderItem {
  name: string;
  qty: number;
  priceCents: number;
}

export type OrderStatus =
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "backordered";

export interface Order {
  orderId: string;
  email: string;
  status: OrderStatus;
  items: OrderItem[];
  totalCents: number;
  refundedCents: number;
  placedAt: string; // ISO timestamp
  trackingNumber?: string | null;
  carrier?: string | null;
  estimatedDelivery?: string | null;
}

export interface Refund {
  id: string;
  orderId: string;
  idempotencyKey: string;
  amountCents: number;
  reason: string;
  status: string;
  sessionId: string;
  createdAt: string;
}

export interface Ticket {
  id: string;
  sessionId: string;
  turnNumber: number;
  subject: string;
  category: string;
  priority: "low" | "medium" | "high";
  summary: string;
  status: string;
  createdAt: string;
}

export interface ToolCallRow {
  id: string;
  sessionId: string;
  turnNumber: number;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  errorCode: string | null;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  status: string;
  state: Record<string, unknown>;
  summary: string;
  escalated: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  modality: "text" | "voice";
  possiblyTruncated: boolean;
  interruptionMeta: Record<string, unknown> | null;
  createdAt: string;
}

export interface TurnTraceRow {
  id: string;
  sessionId: string;
  turnNumber: number;
  trace: TraceEvent[];
  partial: boolean;
  createdAt: string;
}

export class VersionConflictError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} was modified concurrently (version conflict)`);
    this.name = "VersionConflictError";
  }
}

export type RefundExecutionResult =
  | { refund: Refund }
  | { error: "ORDER_NOT_FOUND" | "OVER_BALANCE" };

export interface SessionStore {
  getSession(id: string): Promise<SessionRow | null>;
  createSession(id: string): Promise<SessionRow>;
  /**
   * Save the AgentState snapshot. `expectedVersion` is the version the
   * caller read; the write increments it. Throws VersionConflictError on
   * mismatch.
   */
  saveSessionState(
    id: string,
    state: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<SessionRow>;
  setSessionEscalated(id: string): Promise<void>;

  appendMessage(
    sessionId: string,
    message: Omit<MessageRow, "id" | "sessionId" | "createdAt">,
  ): Promise<MessageRow>;
  getMessages(sessionId: string, limit?: number): Promise<MessageRow[]>;

  saveTurnTrace(
    sessionId: string,
    turnNumber: number,
    trace: TraceEvent[],
    partial: boolean,
  ): Promise<void>;
  getTurnTraces(sessionId: string): Promise<TurnTraceRow[]>;

  getOrder(orderId: string): Promise<Order | null>;
  getOrdersByEmail(email: string, limit?: number): Promise<Order[]>;

  /**
   * Atomic refund execution (idempotent): inserts the refund row and bumps
   * orders.refunded_cents in one transaction (Supabase: `execute_refund`
   * RPC). A retry with the same idempotency key returns the stored refund
   * instead of executing twice.
   */
  executeRefund(args: {
    orderId: string;
    idempotencyKey: string;
    amountCents: number;
    reason: string;
    sessionId: string;
  }): Promise<RefundExecutionResult>;
  getRefundByKey(
    orderId: string,
    idempotencyKey: string,
  ): Promise<Refund | null>;

  /** Creates a ticket; a retry for the same (session, turn) returns the existing one. */
  createTicket(args: {
    sessionId: string;
    turnNumber: number;
    subject: string;
    category: string;
    priority: "low" | "medium" | "high";
    summary: string;
  }): Promise<Ticket>;
  getTicketByTurn(
    sessionId: string,
    turnNumber: number,
  ): Promise<Ticket | null>;

  /** Records a tool call; deduped on (sessionId, callId). */
  recordToolCall(row: {
    sessionId: string;
    turnNumber: number;
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    errorCode: string | null;
  }): Promise<ToolCallRow>;
}

let cachedStore: SessionStore | null = null;

/** Factory: Supabase when configured, in-memory demo store otherwise. */
export async function getStore(): Promise<SessionStore> {
  if (cachedStore) return cachedStore;
  const { isSupabaseConfigured } = await import("@/lib/supabase/server");
  if (isSupabaseConfigured()) {
    const { SupabaseStore } = await import("@/lib/db/supabase-store");
    cachedStore = new SupabaseStore();
  } else {
    const { MemoryStore } = await import("@/lib/db/memory-store");
    cachedStore = new MemoryStore();
  }
  return cachedStore;
}

/** Test hook: reset the cached store (and the in-memory store's data). */
export async function __resetStore(): Promise<void> {
  cachedStore = null;
}
