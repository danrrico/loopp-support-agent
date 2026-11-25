import { describe, expect, it } from "vitest";
import { buildResponseCreatePayload } from "@/lib/voice/realtime-client";
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
