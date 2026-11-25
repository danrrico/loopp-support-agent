import { describe, expect, it } from "vitest";
import { VoiceTranscriptState } from "@/lib/voice/transcript-state";

describe("VoiceTranscriptState", () => {
  it("a final transcript is submitted once per item_id (duplicate delivery is dropped)", () => {
    const state = new VoiceTranscriptState();
    expect(state.isDuplicateFinal("item_1")).toBe(false);
    state.markSubmitted("item_1");
    expect(state.isDuplicateFinal("item_1")).toBe(true);
    expect(state.isDuplicateFinal("item_2")).toBe(false);
    // Empty itemIds cannot be deduped — they always pass.
    expect(state.isDuplicateFinal("")).toBe(false);
    state.markSubmitted("");
    expect(state.isDuplicateFinal("")).toBe(false);
  });

  it("resetSubmitted clears the dedupe set (new call)", () => {
    const state = new VoiceTranscriptState();
    state.markSubmitted("item_1");
    state.resetSubmitted();
    expect(state.isDuplicateFinal("item_1")).toBe(false);
  });

  it("user partials accumulate into ONE draft line in place (no duplicate lines)", () => {
    const state = new VoiceTranscriptState();
    // Live 2026-11-25: replacing the draft with each delta showed only
    // the last fragment and late partials re-appeared as a second line.
    expect(state.accumulateUserPartial("item_1", "Hey, ")).toBe("Hey, ");
    expect(state.accumulateUserPartial("item_1", "how are ")).toBe(
      "Hey, how are ",
    );
    expect(state.accumulateUserPartial("item_1", "you?")).toBe(
      "Hey, how are you?",
    );
    expect(state.getUserDraft()).toBe("Hey, how are you?");
  });

  it("a delta for a new input item starts a fresh draft", () => {
    const state = new VoiceTranscriptState();
    state.accumulateUserPartial("item_1", "Hello.");
    expect(state.accumulateUserPartial("item_2", "Can you")).toBe("Can you");
  });

  it("a cumulative re-send replaces instead of appending (no double-print)", () => {
    const state = new VoiceTranscriptState();
    state.accumulateUserPartial("item_1", "Hey, ");
    expect(state.accumulateUserPartial("item_1", "Hey, how are you?")).toBe(
      "Hey, how are you?",
    );
  });

  it("clearUserDraft drops the draft (new utterance / final received)", () => {
    const state = new VoiceTranscriptState();
    state.accumulateUserPartial("item_1", "Hello.");
    state.clearUserDraft();
    expect(state.getUserDraft()).toBe("");
    expect(state.accumulateUserPartial("item_1", "Hello.")).toBe("Hello.");
  });

  it("agent partials accumulate into ONE draft line — never a bare fragment", () => {
    const state = new VoiceTranscriptState();
    // Live 2026-11-25: "Agent: that" and "Agent: ?" rendered as their
    // own lines because each delta replaced the draft.
    expect(state.accumulateAgentPartial("Let me check ")).toBe(
      "Let me check ",
    );
    expect(state.accumulateAgentPartial("that for you.")).toBe(
      "Let me check that for you.",
    );
    expect(state.getAgentDraft()).toBe("Let me check that for you.");
  });

  it("clearAgentDraft resets for the next response", () => {
    const state = new VoiceTranscriptState();
    state.accumulateAgentPartial("Let me check that for you.");
    state.clearAgentDraft();
    expect(state.getAgentDraft()).toBe("");
    expect(state.accumulateAgentPartial("Hi there!")).toBe("Hi there!");
  });
});
