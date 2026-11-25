import { describe, expect, it } from "vitest";
import {
  initiateRefundSchema,
  orderLookupSchema,
} from "@/lib/tools/schemas";

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
