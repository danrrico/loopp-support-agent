import { describe, expect, it } from "vitest";
import {
  MintError,
  buildMintPayload,
  mintRealtimeClientSecret,
  parseMintResponse,
} from "@/lib/voice/mint";
import { VOICE_CONFIG } from "@/lib/voice/config";

function fakeFetch(status: number, body: unknown) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("buildMintPayload", () => {
  it("pins the verified Realtime model and transport-only config", () => {
    const payload = buildMintPayload();
    expect(payload.expires_after).toEqual({
      anchor: "created_at",
      seconds: VOICE_CONFIG.mintTtlSeconds,
    });
    const session = payload.session as Record<string, unknown>;
    expect(session.type).toBe("realtime");
    expect(session.model).toBe("gpt-realtime-2.1");
    expect(session.tools).toEqual([]);
    expect(session.tool_choice).toBe("none");
    const audio = session.audio as Record<string, Record<string, unknown>>;
    const input = audio.input as Record<string, unknown>;
    expect(input.transcription).toEqual({ model: "whisper-1" });
    const vad = input.turn_detection as Record<string, unknown>;
    expect(vad.type).toBe("server_vad");
    expect(vad.silence_duration_ms).toBe(800);
    expect(vad.threshold).toBe(0.5);
    expect(vad.prefix_padding_ms).toBe(300);
    // The graph answers, not the model — never auto-create a response.
    expect(vad.create_response).toBe(false);
    expect(
      (audio.output as Record<string, unknown>).voice,
    ).toBe("alloy");
  });
});

describe("parseMintResponse", () => {
  it("extracts the ephemeral key, model, expiry and session id", () => {
    const parsed = parseMintResponse({
      value: "ek_test123",
      expires_at: 1795613844,
      session: { id: "sess_abc", model: "gpt-realtime-2.1" },
    });
    expect(parsed).toEqual({
      ephemeralKey: "ek_test123",
      model: "gpt-realtime-2.1",
      expiresAt: 1795613844,
      sessionId: "sess_abc",
    });
  });

  it("throws when there is no client secret value", () => {
    expect(() => parseMintResponse({})).toThrow(MintError);
    expect(() => parseMintResponse({ value: "" })).toThrow(MintError);
  });
});

describe("mintRealtimeClientSecret", () => {
  it("mints and parses a 200 response", async () => {
    const minted = await mintRealtimeClientSecret(
      "sk-test",
      fakeFetch(200, {
        value: "ek_test123",
        expires_at: 1795613844,
        session: { id: "sess_abc", model: "gpt-realtime-2.1" },
      }),
    );
    expect(minted.ephemeralKey).toBe("ek_test123");
    expect(minted.model).toBe("gpt-realtime-2.1");
  });

  it("maps an upstream 429 to OPENAI_RATE_LIMITED", async () => {
    await expect(
      mintRealtimeClientSecret("sk-test", fakeFetch(429, { error: {} })),
    ).rejects.toMatchObject({ status: 429, code: "OPENAI_RATE_LIMITED" });
  });

  it("maps an upstream 401 to MINT_FAILED with the status", async () => {
    await expect(
      mintRealtimeClientSecret("sk-test", fakeFetch(401, { error: {} })),
    ).rejects.toMatchObject({ status: 401, code: "MINT_FAILED" });
  });

  it("maps a network failure to status 0", async () => {
    const failing = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(mintRealtimeClientSecret("sk-test", failing)).rejects.toMatchObject({
      status: 0,
      code: "MINT_FAILED",
    });
  });
});
