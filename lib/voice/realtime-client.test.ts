import { describe, expect, it } from "vitest";
import {
  buildResponseCreatePayload,
  ResponseSequencer,
} from "@/lib/voice/realtime-client";
import { VOICE_CONFIG } from "@/lib/voice/config";

describe("buildResponseCreatePayload", () => {
  it("sends instructions only — no modalities (GA rejects response.modalities)", () => {
    const payload = buildResponseCreatePayload("Hello.");
    expect(payload.type).toBe("response.create");
    const response = payload.response as Record<string, unknown>;
    // Regression test for the live 2026-11-25 failure:
    // "Unknown parameter: 'response.modalities'" — the GA Realtime API
    // has no modalities field on the Response object. Modalities live
    // at session level; the minted session already defaults to
    // output_modalities ["audio"], so nothing is needed here.
    expect(response).not.toHaveProperty("modalities");
    expect(response.instructions).toBe(
      `${VOICE_CONFIG.speakInstructions}\n\nHello.`,
    );
    // No other fields: transport-only speak, verbatim text.
    expect(Object.keys(response).sort()).toEqual(["instructions"]);
  });
});

describe("ResponseSequencer", () => {
  function harness() {
    const sent: Array<Record<string, unknown>> = [];
    const seq = new ResponseSequencer((event) => {
      sent.push(event);
    });
    const creates = () =>
      sent.filter((e) => e.type === "response.create");
    const cancels = () =>
      sent.filter((e) => e.type === "response.cancel");
    return { seq, sent, creates, cancels };
  }

  it("sends response.create immediately when idle", () => {
    const { seq, creates } = harness();
    seq.speak("Hello.");
    expect(creates()).toHaveLength(1);
    expect(
      (creates()[0].response as Record<string, unknown>).instructions,
    ).toContain("Hello.");
  });

  it("answer create waits for the filler cancel (live 2026-11-25: 'Conversation already has an active response in progress')", () => {
    const { seq, creates, cancels } = harness();
    seq.speak(VOICE_CONFIG.fillerText);
    expect(creates()).toHaveLength(1);
    seq.onCreated(); // filler is live
    seq.speak("The real answer.");
    // No second create while the filler is live — and a cancel went out.
    expect(creates()).toHaveLength(1);
    expect(cancels()).toHaveLength(1);
    seq.onEnded(); // server confirmed the filler cancel
    expect(creates()).toHaveLength(2);
    expect(
      (creates()[1].response as Record<string, unknown>).instructions,
    ).toContain("The real answer.");
  });

  it("speak while the create is still in flight waits for created, then cancels, then creates", () => {
    const { seq, creates, cancels } = harness();
    seq.speak("Filler.");
    seq.speak("Answer."); // create not yet confirmed
    expect(creates()).toHaveLength(1);
    expect(cancels()).toHaveLength(0);
    seq.onCreated(); // filler now live → cancel it
    expect(cancels()).toHaveLength(1);
    expect(creates()).toHaveLength(1);
    seq.onEnded();
    expect(creates()).toHaveLength(2);
    expect(
      (creates()[1].response as Record<string, unknown>).instructions,
    ).toContain("Answer.");
  });

  it("cancel while creating cancels as soon as the response exists", () => {
    const { seq, creates, cancels } = harness();
    seq.speak("Filler.");
    seq.cancel();
    expect(cancels()).toHaveLength(0); // nothing live yet to cancel
    seq.onCreated(); // now it exists → cancel goes out
    expect(cancels()).toHaveLength(1);
    seq.onEnded();
    expect(creates()).toHaveLength(1); // no queued speech to create
  });

  it("cancel while idle sends nothing and does not poison the next speak", () => {
    const { seq, creates, cancels } = harness();
    seq.cancel();
    expect(cancels()).toHaveLength(0);
    seq.speak("Hello.");
    expect(creates()).toHaveLength(1);
    seq.onCreated();
    expect(cancels()).toHaveLength(0); // no spurious cancel of the new response
  });

  it("two speaks while active: only the latest text is created after the cancel", () => {
    const { seq, creates, cancels } = harness();
    seq.speak("Filler.");
    seq.onCreated();
    seq.speak("Answer one.");
    seq.speak("Answer two.");
    expect(cancels()).toHaveLength(1);
    seq.onEnded();
    expect(creates()).toHaveLength(2);
    expect(
      (creates()[1].response as Record<string, unknown>).instructions,
    ).toContain("Answer two.");
  });

  it("a create rejected as 'active response in progress' is re-queued and retried after the cancel", () => {
    const { seq, creates, cancels } = harness();
    seq.speak("Hello.");
    seq.onActiveResponseError(); // server still had a live response
    expect(cancels()).toHaveLength(1);
    expect(creates()).toHaveLength(1); // the failed create is not re-sent yet
    seq.onEnded();
    expect(creates()).toHaveLength(2);
    expect(
      (creates()[1].response as Record<string, unknown>).instructions,
    ).toContain("Hello.");
  });
});
