/**
 * Supabase store implementation (architecture-v2.md §5.5, §10.2).
 *
 * All access goes through the service-role client (server-only). RLS
 * denies anon everything, so no browser path can reach these tables.
 *
 * Idempotency is DB-enforced:
 * - refunds: `execute_refund` RPC (migration 0003) — balance check +
 *   insert + refunded_cents bump in one transaction, row-locked.
 * - tickets: UNIQUE (session_id, turn_number) — insert conflicts return
 *   the existing row instead of erroring.
 * - tool_calls: UNIQUE (session_id, call_id) — same pattern.
 * - sessions: optimistic concurrency on `version`.
 */

import { getServiceClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
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

function mapOrder(row: Record<string, unknown>): Order {
  return {
    orderId: row.order_id as string,
    email: row.email as string,
    status: row.status as Order["status"],
    items: (row.items as Array<Record<string, unknown>>).map((i) => ({
      name: i.name as string,
      qty: i.qty as number,
      priceCents: i.price_cents as number,
    })),
    totalCents: row.total_cents as number,
    refundedCents: row.refunded_cents as number,
    placedAt: row.placed_at as string,
    trackingNumber: row.tracking_number as string | null,
    carrier: row.carrier as string | null,
    estimatedDelivery: row.estimated_delivery as string | null,
  };
}

function mapRefund(row: Record<string, unknown>): Refund {
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    idempotencyKey: row.idempotency_key as string,
    amountCents: row.amount_cents as number,
    reason: row.reason as string,
    status: row.status as string,
    sessionId: row.session_id as string,
    createdAt: row.created_at as string,
  };
}

function mapTicket(row: Record<string, unknown>): Ticket {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    turnNumber: row.turn_number as number,
    subject: row.subject as string,
    category: row.category as string,
    priority: row.priority as Ticket["priority"],
    summary: row.summary as string,
    status: row.status as string,
    createdAt: row.created_at as string,
  };
}

function mapSession(row: Record<string, unknown>): SessionRow {
  return {
    id: row.id as string,
    status: row.status as string,
    state: (row.state as Record<string, unknown>) ?? {},
    summary: row.summary as string,
    escalated: row.escalated as boolean,
    version: row.version as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class SupabaseStore implements SessionStore {
  private client(): SupabaseClient {
    const client = getServiceClient();
    if (!client) {
      throw new Error(
        "SupabaseStore used without Supabase configured — use getStore()",
      );
    }
    return client;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const { data, error } = await this.client()
      .from("sessions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getSession failed: ${error.message}`);
    return data ? mapSession(data as Record<string, unknown>) : null;
  }

  async createSession(id: string): Promise<SessionRow> {
    const { data, error } = await this.client()
      .from("sessions")
      .insert({ id })
      .select()
      .single();
    if (error) {
      // Concurrent create with the same id — return the existing row.
      if (error.code === "23505") {
        const existing = await this.getSession(id);
        if (existing) return existing;
      }
      throw new Error(`createSession failed: ${error.message}`);
    }
    return mapSession(data as Record<string, unknown>);
  }

  async saveSessionState(
    id: string,
    state: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<SessionRow> {
    const { data, error } = await this.client()
      .from("sessions")
      .update({
        state,
        version: expectedVersion + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("version", expectedVersion)
      .select();
    if (error) throw new Error(`saveSessionState failed: ${error.message}`);
    if (!data || data.length === 0) throw new VersionConflictError(id);
    return mapSession(data[0] as Record<string, unknown>);
  }

  async setSessionEscalated(id: string): Promise<void> {
    const { error } = await this.client()
      .from("sessions")
      .update({
        escalated: true,
        status: "escalated",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw new Error(`setSessionEscalated failed: ${error.message}`);
  }

  async appendMessage(
    sessionId: string,
    message: Omit<MessageRow, "id" | "sessionId" | "createdAt">,
  ): Promise<MessageRow> {
    const { data, error } = await this.client()
      .from("messages")
      .insert({
        session_id: sessionId,
        role: message.role,
        content: message.content,
        modality: message.modality,
        possibly_truncated: message.possiblyTruncated,
        interruption_meta: message.interruptionMeta,
      })
      .select()
      .single();
    if (error) throw new Error(`appendMessage failed: ${error.message}`);
    const row = data as Record<string, unknown>;
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as MessageRow["role"],
      content: row.content as string,
      modality: row.modality as MessageRow["modality"],
      possiblyTruncated: row.possibly_truncated as boolean,
      interruptionMeta: row.interruption_meta as Record<string, unknown> | null,
      createdAt: row.created_at as string,
    };
  }

  async getMessages(sessionId: string, limit = 20): Promise<MessageRow[]> {
    const { data, error } = await this.client()
      .from("messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`getMessages failed: ${error.message}`);
    return (data as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as MessageRow["role"],
      content: row.content as string,
      modality: row.modality as MessageRow["modality"],
      possiblyTruncated: row.possibly_truncated as boolean,
      interruptionMeta: row.interruption_meta as Record<string, unknown> | null,
      createdAt: row.created_at as string,
    }));
  }

  async saveTurnTrace(
    sessionId: string,
    turnNumber: number,
    trace: TraceEvent[],
    partial: boolean,
  ): Promise<void> {
    const { error } = await this.client().from("turn_traces").upsert(
      {
        session_id: sessionId,
        turn_number: turnNumber,
        trace,
        partial,
      },
      { onConflict: "session_id,turn_number" },
    );
    if (error) throw new Error(`saveTurnTrace failed: ${error.message}`);
  }

  async getTurnTraces(sessionId: string): Promise<TurnTraceRow[]> {
    const { data, error } = await this.client()
      .from("turn_traces")
      .select("*")
      .eq("session_id", sessionId)
      .order("turn_number", { ascending: true });
    if (error) throw new Error(`getTurnTraces failed: ${error.message}`);
    return (data as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      turnNumber: row.turn_number as number,
      trace: row.trace as TraceEvent[],
      partial: row.partial as boolean,
      createdAt: row.created_at as string,
    }));
  }

  async getOrder(orderId: string): Promise<Order | null> {
    const { data, error } = await this.client()
      .from("orders")
      .select("*")
      .eq("order_id", orderId.toUpperCase())
      .maybeSingle();
    if (error) throw new Error(`getOrder failed: ${error.message}`);
    return data ? mapOrder(data as Record<string, unknown>) : null;
  }

  async getOrdersByEmail(email: string, limit = 5): Promise<Order[]> {
    const { data, error } = await this.client()
      .from("orders")
      .select("*")
      .ilike("email", email)
      .order("placed_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`getOrdersByEmail failed: ${error.message}`);
    return (data as Array<Record<string, unknown>>).map(mapOrder);
  }

  async executeRefund(args: {
    orderId: string;
    idempotencyKey: string;
    amountCents: number;
    reason: string;
    sessionId: string;
  }): Promise<RefundExecutionResult> {
    const { data, error } = await this.client().rpc("execute_refund", {
      p_order_id: args.orderId.toUpperCase(),
      p_idempotency_key: args.idempotencyKey,
      p_amount_cents: args.amountCents,
      p_reason: args.reason,
      p_session_id: args.sessionId,
    });
    if (error) throw new Error(`execute_refund RPC failed: ${error.message}`);
    const row = (data as Array<Record<string, unknown>>)?.[0];
    if (!row) throw new Error("execute_refund RPC returned no row");
    if (row.error_code) {
      return { error: row.error_code as "ORDER_NOT_FOUND" | "OVER_BALANCE" };
    }
    return {
      refund: {
        id: row.refund_id as string,
        orderId: row.out_order_id as string,
        idempotencyKey: args.idempotencyKey,
        amountCents: row.out_amount_cents as number,
        reason: args.reason,
        status: row.out_status as string,
        sessionId: args.sessionId,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async getRefundByKey(
    orderId: string,
    idempotencyKey: string,
  ): Promise<Refund | null> {
    const { data, error } = await this.client()
      .from("refunds")
      .select("*")
      .eq("order_id", orderId.toUpperCase())
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`getRefundByKey failed: ${error.message}`);
    return data ? mapRefund(data as Record<string, unknown>) : null;
  }

  async createTicket(args: {
    sessionId: string;
    turnNumber: number;
    subject: string;
    category: string;
    priority: "low" | "medium" | "high";
    summary: string;
  }): Promise<Ticket> {
    const { data, error } = await this.client()
      .from("tickets")
      .insert({
        session_id: args.sessionId,
        turn_number: args.turnNumber,
        subject: args.subject,
        category: args.category,
        priority: args.priority,
        summary: args.summary,
      })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        const existing = await this.getTicketByTurn(
          args.sessionId,
          args.turnNumber,
        );
        if (existing) return existing;
      }
      throw new Error(`createTicket failed: ${error.message}`);
    }
    return mapTicket(data as Record<string, unknown>);
  }

  async getTicketByTurn(
    sessionId: string,
    turnNumber: number,
  ): Promise<Ticket | null> {
    const { data, error } = await this.client()
      .from("tickets")
      .select("*")
      .eq("session_id", sessionId)
      .eq("turn_number", turnNumber)
      .maybeSingle();
    if (error) throw new Error(`getTicketByTurn failed: ${error.message}`);
    return data ? mapTicket(data as Record<string, unknown>) : null;
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
    const { data, error } = await this.client()
      .from("tool_calls")
      .insert({
        session_id: row.sessionId,
        turn_number: row.turnNumber,
        call_id: row.callId,
        tool_name: row.toolName,
        args: row.args,
        result: row.result,
        error_code: row.errorCode,
      })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        // Already recorded (retry) — fetch the stored row.
        const { data: existing, error: fetchError } = await this.client()
          .from("tool_calls")
          .select("*")
          .eq("session_id", row.sessionId)
          .eq("call_id", row.callId)
          .maybeSingle();
        if (fetchError) {
          throw new Error(`recordToolCall fetch failed: ${fetchError.message}`);
        }
        if (existing) {
          const r = existing as Record<string, unknown>;
          return {
            id: r.id as string,
            sessionId: r.session_id as string,
            turnNumber: r.turn_number as number,
            callId: r.call_id as string,
            toolName: r.tool_name as string,
            args: r.args as Record<string, unknown>,
            result: r.result,
            errorCode: r.error_code as string | null,
            createdAt: r.created_at as string,
          };
        }
      }
      throw new Error(`recordToolCall failed: ${error.message}`);
    }
    const r = data as Record<string, unknown>;
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      turnNumber: r.turn_number as number,
      callId: r.call_id as string,
      toolName: r.tool_name as string,
      args: r.args as Record<string, unknown>,
      result: r.result,
      errorCode: r.error_code as string | null,
      createdAt: r.created_at as string,
    };
  }
}
