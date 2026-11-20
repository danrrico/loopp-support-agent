import { describe, expect, it } from "vitest";
import {
  buildHandoffMessage,
  checkRepeatedFailure,
} from "@/lib/agent/escalation";
import { MockEmbedder } from "@/lib/rag/embeddings";

const embedder = new MockEmbedder();

describe("buildHandoffMessage", () => {
  it("refund_over_500 names the human-approval reason", () => {
    expect(buildHandoffMessage("refund_over_500")).toMatch(/over \$500/);
  });

  it("explicit_request acknowledges the request", () => {
    expect(buildHandoffMessage("explicit_request")).toMatch(/Of course/);
  });
});

describe("checkRepeatedFailure", () => {
  it("two consecutive caveat turns → repeated", async () => {
    const r = await checkRepeatedFailure({
      recentTracks: ["answer", "caveat", "caveat"],
      lastUserMessages: [],
      currentMessage: "Hello?",
      embedder,
    });
    expect(r.repeated).toBe(true);
    expect(r.reason).toMatch(/Caveat/);
  });

  it("one caveat turn is not enough", async () => {
    const r = await checkRepeatedFailure({
      recentTracks: ["answer", "caveat"],
      lastUserMessages: [],
      currentMessage: "Hello?",
      embedder,
    });
    expect(r.repeated).toBe(false);
  });

  it("re-ask + negative signal → repeated", async () => {
    const r = await checkRepeatedFailure({
      recentTracks: ["answer"],
      lastUserMessages: ["How do I return a jacket?"],
      currentMessage: "That didn't help — how do I return a jacket?",
      embedder,
    });
    expect(r.repeated).toBe(true);
    expect(r.reason).toMatch(/re-asked/);
  });

  it("re-ask WITHOUT a negative signal does not escalate", async () => {
    const r = await checkRepeatedFailure({
      recentTracks: ["answer"],
      lastUserMessages: ["How do I return a jacket?"],
      currentMessage: "How do I return a jacket?",
      embedder,
    });
    expect(r.repeated).toBe(false);
  });

  it("negative signal on a DIFFERENT question does not escalate", async () => {
    const r = await checkRepeatedFailure({
      recentTracks: ["answer"],
      lastUserMessages: ["How do I return a jacket?"],
      currentMessage: "That didn't help — how long is the warranty?",
      embedder,
    });
    expect(r.repeated).toBe(false);
  });
});
