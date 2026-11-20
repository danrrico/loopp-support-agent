/**
 * Server-side trace events (architecture-v2.md §6).
 *
 * Everything the observability drawer shows comes from structured trace
 * events emitted by the SERVER — browser-supplied traces are not an
 * operational record. Events ride the SSE stream as typed `trace` events
 * and persist to `turn_traces` (JSONB) so a reloaded session shows history.
 *
 * PII minimization (§6.3): tool payloads are redacted before they enter a
 * trace — order IDs and amounts are kept (they are the demo's substance),
 * emails are masked to `a***@domain`.
 */

export type TraceEventType =
  | "route"
  | "retrieval"
  | "evidence_check"
  | "checking_policy"
  | "tool_call"
  | "tool_result"
  | "verifier"
  | "escalation"
  | "tool_budget_exhausted"
  | "awaiting_confirmation"
  | "awaiting_user"
  | "done"
  | "error";

export interface TraceEvent {
  type: TraceEventType;
  turn: number;
  /** ISO timestamp. */
  at: string;
  /** Milliseconds since the turn started. */
  elapsedMs: number;
  payload: Record<string, unknown>;
}

/** Mask an email address to `a***@domain` (first char + domain kept). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Deep-redact a value: mask any email addresses found in strings. */
export function redactPII(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(EMAIL_RE, (m) => maskEmail(m));
  }
  if (Array.isArray(value)) return value.map(redactPII);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPII(v);
    }
    return out;
  }
  return value;
}

/** Collects the trace events for one turn. */
export class TraceCollector {
  private readonly events: TraceEvent[] = [];
  private readonly startedAt = Date.now();

  constructor(private readonly turn: number) {}

  emit(type: TraceEventType, payload: Record<string, unknown> = {}): void {
    this.events.push({
      type,
      turn: this.turn,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      payload: redactPII(payload) as Record<string, unknown>,
    });
  }

  getEvents(): TraceEvent[] {
    return [...this.events];
  }

  get totalLatencyMs(): number {
    return Date.now() - this.startedAt;
  }
}
