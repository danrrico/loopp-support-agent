/**
 * Typed fetch wrappers for the session + voice APIs.
 */

import type { SessionData, TraceEvent } from "@/lib/client/types";

export async function fetchSession(): Promise<SessionData> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`Failed to load session (${res.status})`);
  return (await res.json()) as SessionData;
}

export async function startNewSession(): Promise<{ sessionId: string }> {
  const res = await fetch("/api/sessions", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to start a new session (${res.status})`);
  return (await res.json()) as { sessionId: string };
}

export interface VoiceTranscriptResult {
  speakableText: string;
  trace: TraceEvent[];
  turnNumber: number;
  terminalState: string;
  ticketId: string | null;
  duplicate?: boolean;
}

export async function postVoiceTranscript(
  transcript: string,
  itemId: string,
): Promise<VoiceTranscriptResult> {
  const res = await fetch("/api/voice/transcript", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, itemId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Transcript failed (${res.status})`);
  }
  return (await res.json()) as VoiceTranscriptResult;
}

/** Mint a Realtime session. 503 until the voice spike lands (see the route). */
export async function mintVoiceSession(): Promise<{ ephemeralKey: string }> {
  const res = await fetch("/api/voice/session", { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    const err = new Error(body.error ?? `Mint failed (${res.status})`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as { ephemeralKey: string };
}
