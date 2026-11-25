import { describe, expect, it } from "vitest";
import { pickFiller } from "@/lib/voice/config";

describe("pickFiller — contextual voice acknowledgement", () => {
  it("names the order ID back for order questions", () => {
    expect(pickFiller("Where is my order NW-88412?")).toBe(
      "Checking order NW-88412…",
    );
    expect(pickFiller("Where is my order NW88412?")).toBe(
      "Checking order NW-88412…",
    );
  });

  it("varies by topic instead of repeating one phrase", () => {
    expect(pickFiller("I want a refund for order NW-88412.")).toMatch(
      /refund/i,
    );
    expect(pickFiller("How long is the warranty?")).toBe(
      "Looking up the warranty…",
    );
    expect(pickFiller("What is your return policy?")).toBe(
      "Checking the return policy…",
    );
    expect(pickFiller("Can you fix my tent pole?")).toBe(
      "Checking that for you…",
    );
  });

  it("falls back to a short neutral acknowledgement", () => {
    expect(pickFiller("Hello?")).toBe("One moment…");
  });
});
