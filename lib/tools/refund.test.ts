import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/db/memory-store";
import {
  checkRefundEligibility,
  executeInitiateRefund,
  executeOrderLookup,
} from "@/lib/tools/execute";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("checkRefundEligibility (integer cents, code-computed)", () => {
  it("delivered + within 60 days → eligible for the full remaining balance", () => {
    const r = checkRefundEligibility({
      status: "delivered",
      placedAt: daysAgo(12),
      totalCents: 12900,
      refundedCents: 0,
    });
    expect(r).toEqual({ eligible: true, amountCents: 12900 });
  });

  it("partially refunded → eligible for the remainder only", () => {
    const r = checkRefundEligibility({
      status: "delivered",
      placedAt: daysAgo(12),
      totalCents: 12900,
      refundedCents: 5000,
    });
    expect(r).toEqual({ eligible: true, amountCents: 7900 });
  });

  it("shipped (not delivered) → not eligible", () => {
    const r = checkRefundEligibility({
      status: "shipped",
      placedAt: daysAgo(2),
      totalCents: 12900,
      refundedCents: 0,
    });
    expect(r.eligible).toBe(false);
  });

  it("outside the 60-day window → not eligible", () => {
    const r = checkRefundEligibility({
      status: "delivered",
      placedAt: daysAgo(75),
      totalCents: 12900,
      refundedCents: 0,
    });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toMatch(/60 days/);
  });

  it("fully refunded → not eligible", () => {
    const r = checkRefundEligibility({
      status: "delivered",
      placedAt: daysAgo(12),
      totalCents: 12900,
      refundedCents: 12900,
    });
    expect(r.eligible).toBe(false);
  });
});

describe("executeOrderLookup", () => {
  const ctx = {
    store: new MemoryStore(),
    sessionId: "00000000-0000-4000-8000-000000000001",
    turnNumber: 1,
  };

  it("finds the demo order by ID", async () => {
    const r = await executeOrderLookup({ orderId: "NW-88412" }, ctx);
    expect(r.outcome).toBe("ok");
    expect(r.data.orderId).toBe("NW-88412");
    expect(r.data.status).toBe("delivered");
    expect(r.data.totalCents).toBe(12900);
    expect(r.data.refundableCents).toBe(12900);
  });

  it("normalizes a lowercase order ID", async () => {
    const r = await executeOrderLookup({ orderId: "nw-88412" }, ctx);
    expect(r.outcome).toBe("ok");
  });

  it("unknown order → ORDER_NOT_FOUND business outcome", async () => {
    const r = await executeOrderLookup({ orderId: "NW-00000" }, ctx);
    expect(r.outcome).toBe("business");
    expect(r.errorCode).toBe("ORDER_NOT_FOUND");
  });

  it("email lookup returns matches and flags disambiguation", async () => {
    const r = await executeOrderLookup({ email: "alex@example.com" }, ctx);
    expect(r.outcome).toBe("ok");
    expect((r.data.orders as unknown[]).length).toBe(2);
    expect(r.data.needsDisambiguation).toBe(true);
  });

  it("neither orderId nor email → validation system error", async () => {
    const r = await executeOrderLookup({}, ctx);
    expect(r.outcome).toBe("system");
    expect(r.errorCode).toBe("VALIDATION_ERROR");
  });
});

describe("executeInitiateRefund — two-phase + idempotency", () => {
  const sessionId = "00000000-0000-4000-8000-000000000002";

  it("phase 1 proposes with a token and the exact amount; no side effect", async () => {
    const store = new MemoryStore();
    const r = await executeInitiateRefund(
      { orderId: "NW-88412", reason: "Changed my mind" },
      { store, sessionId, turnNumber: 1 },
    );
    expect(r.outcome).toBe("ok");
    expect(r.data.status).toBe("REQUIRES_CONFIRMATION");
    expect(r.data.amountCents).toBe(12900);
    expect(r.data.amountDisplay).toBe("$129.00");
    expect(typeof r.data.confirmationToken).toBe("string");
    // No refund row exists yet.
    const order = await store.getOrder("NW-88412");
    expect(order?.refundedCents).toBe(0);
  });

  it("phase 2 executes, bumps refunded_cents, and is idempotent on retry", async () => {
    const store = new MemoryStore();
    const ctx = { store, sessionId, turnNumber: 1 };
    const propose = await executeInitiateRefund(
      { orderId: "NW-88412", reason: "Changed my mind" },
      ctx,
    );
    const token = propose.data.confirmationToken as string;
    const execCtx = { ...ctx, pendingConfirmationToken: token };
    const first = await executeInitiateRefund(
      { orderId: "NW-88412", reason: "Changed my mind", confirmationToken: token },
      execCtx,
    );
    expect(first.outcome).toBe("ok");
    expect(first.data.status).toBe("initiated");
    expect(first.data.refundId).toMatch(/^RF-\d{4}$/);
    const order = await store.getOrder("NW-88412");
    expect(order?.refundedCents).toBe(12900);

    // Retry with the same token (same idempotency key) → same refund, no double-execute.
    const retry = await executeInitiateRefund(
      { orderId: "NW-88412", reason: "Changed my mind", confirmationToken: token },
      execCtx,
    );
    expect(retry.outcome).toBe("ok");
    expect(retry.data.refundId).toBe(first.data.refundId);
    const orderAfter = await store.getOrder("NW-88412");
    expect(orderAfter?.refundedCents).toBe(12900);
  });

  it("phase 2 with a wrong token → validation system error, no side effect", async () => {
    const store = new MemoryStore();
    const ctx = {
      store,
      sessionId,
      turnNumber: 1,
      pendingConfirmationToken: "11111111-1111-4111-8111-111111111111",
    };
    const r = await executeInitiateRefund(
      {
        orderId: "NW-88412",
        reason: "Changed my mind",
        confirmationToken: "22222222-2222-4222-8222-222222222222",
      },
      ctx,
    );
    expect(r.outcome).toBe("system");
    expect(r.errorCode).toBe("VALIDATION_ERROR");
    const order = await store.getOrder("NW-88412");
    expect(order?.refundedCents).toBe(0);
  });

  it("over $500 → REFUND_OVER_LIMIT after confirmation (escalation signal)", async () => {
    const store = new MemoryStore();
    const ctx = { store, sessionId, turnNumber: 1 };
    const propose = await executeInitiateRefund(
      { orderId: "NW-88415", reason: "Too expensive" },
      ctx,
    );
    expect(propose.outcome).toBe("ok");
    expect(propose.data.amountCents).toBe(73800);
    const token = propose.data.confirmationToken as string;
    const r = await executeInitiateRefund(
      { orderId: "NW-88415", reason: "Too expensive", confirmationToken: token },
      { ...ctx, pendingConfirmationToken: token },
    );
    expect(r.outcome).toBe("business");
    expect(r.errorCode).toBe("REFUND_OVER_LIMIT");
    const order = await store.getOrder("NW-88415");
    expect(order?.refundedCents).toBe(0);
  });

  it("outside-window order → REFUND_NOT_ELIGIBLE business outcome", async () => {
    const store = new MemoryStore();
    const r = await executeInitiateRefund(
      { orderId: "NW-88414", reason: "Changed my mind" },
      { store, sessionId, turnNumber: 1 },
    );
    expect(r.outcome).toBe("business");
    expect(r.errorCode).toBe("REFUND_NOT_ELIGIBLE");
  });
});
