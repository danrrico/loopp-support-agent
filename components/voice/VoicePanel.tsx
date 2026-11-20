"use client";

import { useState } from "react";
import { mintVoiceSession } from "@/lib/client/api";
import { Waveform } from "@/components/voice/Waveform";

/**
 * Voice panel — UI shell (architecture-v2.md §4).
 *
 * Voice is TRANSPORT ONLY: Realtime transcribes + speaks; the server
 * LangGraph decides everything. The state machine below (§4.5) is the real
 * one — idle | listening | awaiting_graph | speaking | interrupted |
 * disconnected | error — but until the Day 1 voice spike lands (OpenAI key
 * + pinned Realtime model), minting returns 503 and the panel honestly
 * reports that voice is not configured. The waveform, transcript pane, and
 * state transitions are wired to light up the moment a Realtime session
 * attaches a stream.
 */

export type VoiceState =
  | "idle"
  | "listening"
  | "awaiting_graph"
  | "speaking"
  | "interrupted"
  | "disconnected"
  | "error";

const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Idle — press Talk to start",
  listening: "Listening…",
  awaiting_graph: "Checking that for you…",
  speaking: "Speaking…",
  interrupted: "Interrupted — tap to resume",
  disconnected: "Disconnected",
  error: "Voice unavailable",
};

const STATE_COLOR: Record<VoiceState, string> = {
  idle: "bg-zinc-400",
  listening: "bg-green-500",
  awaiting_graph: "bg-amber-500",
  speaking: "bg-blue-500",
  interrupted: "bg-orange-500",
  disconnected: "bg-zinc-400",
  error: "bg-red-500",
};

export function VoicePanel({ onClose }: { onClose: () => void }) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<
    Array<{ role: "user" | "assistant"; text: string; final: boolean }>
  >([]);

  async function handleTalk() {
    setError(null);
    try {
      // Minting is a 503 stub until the voice spike lands.
      await mintVoiceSession();
      // Unreachable today — when minting works, the Realtime client
      // attaches here and drives listening/speaking states.
      setVoiceState("listening");
    } catch (err) {
      const e = err as Error & { status?: number };
      setVoiceState("error");
      setError(
        e.status === 503
          ? "Voice needs an OpenAI key — the Day 1 voice spike (Realtime model pin + minting) is still pending. Text chat works fully in the meantime."
          : e.message,
      );
    }
  }

  function handleDisconnect() {
    // Explicit audio lifecycle (§4.3): no stream is attached today, so
    // there is nothing to stop — the Realtime client will stop tracks,
    // close the peer connection + AudioContext, and cancel the RAF here.
    setTranscript([]);
    setVoiceState("disconnected");
    window.setTimeout(() => setVoiceState("idle"), 1500);
  }

  const active = voiceState === "listening" || voiceState === "speaking";

  return (
    <div className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800 sm:px-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${STATE_COLOR[voiceState]}`}
            aria-hidden
          />
          <h2 className="text-sm font-semibold">
            Live voice {voiceState !== "idle" && `— ${STATE_LABEL[voiceState]}`}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close voice panel"
          className="rounded-full px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          ✕
        </button>
      </div>

      <div className="mt-3">
        <Waveform stream={null} active={active} />
      </div>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={handleTalk}
          disabled={voiceState === "listening" || voiceState === "awaiting_graph" || voiceState === "speaking"}
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          🎙 Talk
        </button>
        {(voiceState === "listening" ||
          voiceState === "speaking" ||
          voiceState === "interrupted" ||
          voiceState === "awaiting_graph") && (
          <button
            type="button"
            onClick={handleDisconnect}
            className="rounded-full border border-zinc-300 px-5 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            End call
          </button>
        )}
      </div>

      {/* Live transcript pane — partial transcripts render dimmed/italic. */}
      <div className="mt-3 min-h-10 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
        {transcript.length === 0 ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Live transcript appears here during a voice call. Final
            transcripts land in the message list alongside text chat — one
            conversation, two modalities.
          </p>
        ) : (
          transcript.map((line, i) => (
            <p
              key={i}
              className={line.final ? "" : "italic text-zinc-400"}
            >
              <span className="font-semibold">
                {line.role === "user" ? "You" : "Agent"}:
              </span>{" "}
              {line.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
