import { describe, expect, it } from "vitest";

// Smoke test: proves the vitest harness runs. Real suites live next to the
// modules they cover (lib/agent/*.test.ts, lib/tools/*.test.ts).
describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
