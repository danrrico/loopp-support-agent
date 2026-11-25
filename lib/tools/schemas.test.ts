import { describe, expect, it } from "vitest";
import {
  extractOrderId,
  initiateRefundSchema,
  orderLookupSchema,
} from "@/lib/tools/schemas";

describe("extractOrderId — free-text order ID extraction", () => {
  it.each([
    ["Where is my order NW-88412?", "NW-88412"],
    ["Where is my order NW88412?", "NW-88412"],
    ["Where is my order NW 88412?", "NW-88412"],
    ["Where is my order, NW eight eight four one two?", "NW-88412"],
    ["track nw eight eight four one two please", "NW-88412"],
    ["refund order NW-88412 please", "NW-88412"],
  ])("extracts %s → %s", (text, expected) => {
    expect(extractOrderId(text)).toBe(expected);
  });

  it.each([
    "Where is my order?",
    "What is your return policy?",
    "NW-884", // too short
    "NW eight eight four", // only 3 spoken digits
  ])("returns null for %s", (text) => {
    expect(extractOrderId(text)).toBeNull();
  });
});

describe("orderLookupSchema — order ID normalization", () => {
  it.each(["NW-88412", "NW88412", "NW 88412", "nw-88412", "  NW-88412  "])(
    "accepts %s and normalizes to NW-88412",
    (raw) => {
      const parsed = orderLookupSchema.safeParse({ orderId: raw });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.orderId).toBe("NW-88412");
    },
  );

  it.each(["NW-884", "NW-884123", "XX-88412", "NW-ABCDE", ""])(
    "rejects malformed ID %s",
    (raw) => {
      const parsed = orderLookupSchema.safeParse({ orderId: raw });
      expect(parsed.success).toBe(false);
    },
  );

  it("still requires orderId or email", () => {
    expect(orderLookupSchema.safeParse({}).success).toBe(false);
    expect(
      orderLookupSchema.safeParse({ email: "a@b.com" }).success,
    ).toBe(true);
  });
});

describe("initiateRefundSchema — shares the same normalization", () => {
  it("accepts the bare spoken form NW88412", () => {
    const parsed = initiateRefundSchema.safeParse({
      orderId: "NW88412",
      reason: "Customer requested a return.",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.orderId).toBe("NW-88412");
  });
});
