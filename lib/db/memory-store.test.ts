import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/db/memory-store";
import { VersionConflictError } from "@/lib/db/store";

const SESSION = "00000000-0000-4000-8000-000000000010";

describe("MemoryStore — sessions + optimistic concurrency", () => {
  it("saveSessionState increments version; stale writes conflict", async () => {
    const store = new MemoryStore();
    await store.createSession(SESSION);
    const saved = await store.saveSessionState(SESSION, { a: 1 }, 0);
    expect(saved.version).toBe(1);
    await expect(
      store.saveSessionState(SESSION, { a: 2 }, 0),
    ).rejects.toBeInstanceOf(VersionConflictError);
    const ok = await store.saveSessionState(SESSION, { a: 2 }, 1);
    expect(ok.version).toBe(2);
    expect(ok.state).toEqual({ a: 2 });
  });

  it("setSessionEscalated marks the session", async () => {
    const store = new MemoryStore();
    await store.createSession(SESSION);
    await store.setSessionEscalated(SESSION);
    const row = await store.getSession(SESSION);
    expect(row?.escalated).toBe(true);
    expect(row?.status).toBe("escalated");
  });
});

describe("MemoryStore — idempotency", () => {
  it("executeRefund with the same key twice returns the same refund", async () => {
    const store = new MemoryStore();
    const args = {
      orderId: "NW-88412",
      idempotencyKey: `${SESSION}:1:token-1`,
      amountCents: 12900,
      reason: "test",
      sessionId: SESSION,
    };
    const first = await store.executeRefund(args);
    const second = await store.executeRefund(args);
    expect("refund" in first && "refund" in second).toBe(true);
    if ("refund" in first && "refund" in second) {
      expect(second.refund.id).toBe(first.refund.id);
    }
    const order = await store.getOrder("NW-88412");
    expect(order?.refundedCents).toBe(12900);
  });

  it("executeRefund over the remaining balance → OVER_BALANCE", async () => {
    const store = new MemoryStore();
    const r = await store.executeRefund({
      orderId: "NW-88412",
      idempotencyKey: `${SESSION}:1:token-2`,
      amountCents: 999999,
      reason: "test",
      sessionId: SESSION,
    });
    expect(r).toEqual({ error: "OVER_BALANCE" });
    const order = await store.getOrder("NW-88412");
    expect(order?.refundedCents).toBe(0);
  });

  it("createTicket for the same (session, turn) twice returns the same ticket", async () => {
    const store = new MemoryStore();
    const args = {
      sessionId: SESSION,
      turnNumber: 3,
      subject: "s",
      category: "stage1_fail",
      priority: "medium" as const,
      summary: "summary",
    };
    const first = await store.createTicket(args);
    const second = await store.createTicket(args);
    expect(second.id).toBe(first.id);
  });

  it("recordToolCall dedupes on (sessionId, callId)", async () => {
    const store = new MemoryStore();
    const row = {
      sessionId: SESSION,
      turnNumber: 1,
      callId: "call_1",
      toolName: "orderLookup",
      args: { orderId: "NW-88412" },
      result: { status: "delivered" },
      errorCode: null,
    };
    const first = await store.recordToolCall(row);
    const second = await store.recordToolCall(row);
    expect(second.id).toBe(first.id);
  });
});
