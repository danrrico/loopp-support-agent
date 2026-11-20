/**
 * Client-side types mirroring the server API (architecture-v2.md §6, §7).
 * Type-only imports from server modules are safe in client components.
 */

import type { TraceEvent } from "@/lib/trace";

export type { TraceEvent };

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  modality: "text" | "voice";
  possiblyTruncated: boolean;
  createdAt: string;
}

export interface TurnTrace {
  turnNumber: number;
  trace: TraceEvent[];
  partial: boolean;
}

export interface SessionData {
  sessionId: string;
  escalated: boolean;
  turnCount: number;
  messages: SessionMessage[];
  traces: TurnTrace[];
}

export interface ChatDone {
  turnNumber: number;
  terminalState: string;
  totalLatencyMs: number;
  partial: boolean;
}

export interface ChatStreamError {
  code: string;
  message: string;
}

/** Evidence track derived from a turn's trace (for dots + totals). */
export function trackOfTrace(trace: TraceEvent[]): "answer" | "caveat" | "escalate" | null {
  const escalation = trace.find((e) => e.type === "escalation");
  if (escalation) return "escalate";
  const check = [...trace]
    .reverse()
    .find((e) => e.type === "evidence_check");
  if (check && typeof check.payload.track === "string") {
    const track = check.payload.track as string;
    if (track === "answer" || track === "caveat" || track === "escalate") {
      return track;
    }
  }
  return null;
}
