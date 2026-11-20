/**
 * In-memory demo store (architecture-v2.md §5.5).
 *
 * Used when Supabase is not configured. Seeded from data/mock-orders.json
 * at first use (daysAgo → placed_at, so the 60-day window stays stable).
 * Implements the same interface and the same invariants as the Supabase
 * store — idempotency keys, unique (session, turn) tickets, optimistic
 * version checks — so the graph behaves identically. State does NOT
 * survive a restart or cross Vercel instances; the README says so plainly.
 */

import { randomUUID } from "node:crypto";
import { loadMockOrders } from "@/lib/db/mock-orders";
import {
  VersionConflictError,
  type MessageRow,
  type Order,
  type Refund,
  type RefundExecutionResult,
  type SessionRow,
  type SessionStore,
  type Ticket,
  type ToolCallRow,
  type TurnTraceRow,
} from "@/lib/db/store";
import type { TraceEvent } from "@/lib/trace";

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryStore implements SessionStore {
  private sessions = new Map<string, SessionRow>();
  private messages = new Map<string, MessageRow[]>();
  private traces = new Map<string, TurnTraceRow>();
  private orders = new Map<string, Order>();
  private refunds = new Map<string, Refund>(); // key: orderId + "|" + idempotencyKey
  private tickets = new Map<string, Ticket>(); // key: sessionId + "|" + turnNumber
  private toolCalls = new Map<string, ToolCallRow>(); // key: sessionId + "|" + callId
  private seeded = false;

  private seedOrders(): void {
    if (this.seeded) return;
    this.seeded = true;
    for (const o of loadMockOrders()) {
      this.orders.set(o.order_id, {
        orderId: o.order_id,
        email: o.email,
        status: o.status as Order["status"],
        items: o.items.map((i) => ({
          name: i.name,
          qty: i.qty,
          priceCents: i.price_cents,
        })),
        totalCents: o.total_cents,
        refundedCents: o.refunded_cents,
        placedAt: o.placed_at,
        trackingNumber: o.tracking_number ?? null,
        carrier: o.carrier ?? null,
        estimatedDelivery: o.estimated_delivery ?? null,
      });
    }
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return this.sessions.get(id) ?? null;
  }

  async createSession(id: string): Promise<SessionRow> {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const row: SessionRow = {
      id,
      status: "active",
      state: {},
      summary: "",
      escalated: false,
      version: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.sessions.set(id, row);
    return row;
  }

  async saveSessionState(
    id: string,
    state: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<SessionRow> {
    const row = this.sessions.get(id);
    if (!row) throw new Error(`Session ${id} not found`);
    if (row.version !== expectedVersion) {
      throw new VersionConflictError(id);
    }
    const updated: SessionRow = {
      ...row,
      state,
      version: row.version + 1,
      updatedAt: nowIso(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  async setSessionEscalated(id: string): Promise<void> {
    const row = this.sessions.get(id);
    if (!row) throw new Error(`Session ${id} not found`);
    this.sessions.set(id, {
      ...row,
      escalated: true,
      status: "escalated",
      updatedAt: nowIso(),
    });
  }

  async appendMessage(
    sessionId: string,
    message: Omit<MessageRow, "id" | "sessionId" | "createdAt">,
  ): Promise<MessageRow> {
    const row: MessageRow = {
      id: randomUUID(),
      sessionId,
      createdAt: nowIso(),
      ...message,
    };
    const list = this.messages.get(sessionId) ?? [];
    list.push(row);
    this.messages.set(sessionId, list);
    return row;
  }

  async getMessages(sessionId: string, limit = 20): Promise<MessageRow[]> {
    const list = this.messages.get(sessionId) ?? [];
    return list.slice(-limit);
  }

  async saveTurnTrace(
    sessionId: string,
    turnNumber: number,
    trace: TraceEvent[],
    partial: boolean,
  ): Promise<void> {
    const key = `${sessionId}|${turnNumber}`;
    const existing = this.traces.get(key);
    this.traces.set(key, {
      id: existing?.id ?? randomUUID(),
      sessionId,
      turnNumber,
      trace,
      partial,
      createdAt: existing?.createdAt ?? nowIso(),
    });
  }

  async getTurnTraces(sessionId: string): Promise<TurnTraceRow[]> {
    return [...this.traces.values()]
      .filter((t) => t.sessionId === sessionId)
      .sort((a, b) => a.turnNumber - b.turnNumber);
  }

  async getOrder(orderId: string): Promise<Order | null> {
    this.seedOrders();
    return this.orders.get(orderId.toUpperCase()) ?? null;
  }

  async getOrdersByEmail(email: string, limit = 5): Promise<Order[]> {
    this.seedOrders();
    const lower = email.toLowerCase();
    return [...this.orders.values()]
      .filter((o) => o.email.toLowerCase() === lower)
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
      .slice(0, limit);
  }

  async executeRefund(args: {
    orderId: string;
    idempotencyKey: string;
    amountCents: number;
    reason: string;
    sessionId: string;
  }): Promise<RefundExecutionResult> {
    this.seedOrders();
    const key = `${args.orderId}|${args.idempotencyKey}`;
    const existing = this.refunds.get(key);
    if (existing) return { refund: existing };
    const order = this.orders.get(args.orderId.toUpperCase());
    if (!order) return { error: "ORDER_NOT_FOUND" };
    // Single-threaded JS: the check + update below is atomic within one
    // event-loop turn (no await between them).
    if (
      args.amountCents <= 0 ||
      args.amountCents > order.totalCents - order.refundedCents
    ) {
      return { error: "OVER_BALANCE" };
    }
    const refund: Refund = {
      id: randomUUID(),
      orderId: order.orderId,
      idempotencyKey: args.idempotencyKey,
      amountCents: args.amountCents,
      reason: args.reason,
      status: "initiated",
      sessionId: args.sessionId,
      createdAt: nowIso(),
    };
    this.refunds.set(key, refund);
    this.orders.set(order.orderId, {
      ...order,
      refundedCents: order.refundedCents + args.amountCents,
    });
    return { refund };
  }

  async getRefundByKey(
    orderId: string,
    idempotencyKey: string,
  ): Promise<Refund | null> {
    return this.refunds.get(`${orderId}|${idempotencyKey}`) ?? null;
  }

  async createTicket(args: {
    sessionId: string;
    turnNumber: number;
    subject: string;
    category: string;
    priority: "low" | "medium" | "high";
    summary: string;
  }): Promise<Ticket> {
    const key = `${args.sessionId}|${args.turnNumber}`;
    const existing = this.tickets.get(key);
    if (existing) return existing;
    const ticket: Ticket = {
      id: randomUUID(),
      sessionId: args.sessionId,
      turnNumber: args.turnNumber,
      subject: args.subject,
      category: args.category,
      priority: args.priority,
      summary: args.summary,
      status: "open",
      createdAt: nowIso(),
    };
    this.tickets.set(key, ticket);
    return ticket;
  }

  async getTicketByTurn(
    sessionId: string,
    turnNumber: number,
  ): Promise<Ticket | null> {
    return this.tickets.get(`${sessionId}|${turnNumber}`) ?? null;
  }

  async recordToolCall(row: {
    sessionId: string;
    turnNumber: number;
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    errorCode: string | null;
  }): Promise<ToolCallRow> {
    const key = `${row.sessionId}|${row.callId}`;
    const existing = this.toolCalls.get(key);
    if (existing) return existing;
    const record: ToolCallRow = {
      id: randomUUID(),
      createdAt: nowIso(),
      ...row,
    };
    this.toolCalls.set(key, record);
    return record;
  }
}
