/** Shared types for the Loopp Support Agent. */

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /** ISO timestamp of when the message was created. */
  createdAt: string;
  /** Optional tool call this message is attached to (assistant messages). */
  toolCallId?: string;
}

/** A single chat session, persisted in Supabase. */
export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Human-readable title, derived from the first user message. */
  title?: string;
  messages: Message[];
  /** True when the session was escalated to a human agent. */
  escalated: boolean;
}

/** One step in an agent run, shown in the observability drawer. */
export interface TraceStep {
  id: string;
  /** e.g. "retrieval" | "model" | "tool:orderLookup" | "escalation". */
  kind: string;
  label: string;
  /** Milliseconds this step took. */
  latencyMs: number;
  /** ISO timestamp when the step started. */
  startedAt: string;
  /** Free-form detail payload (retrieval hits, tool args/results, etc.). */
  detail?: Record<string, unknown>;
}

/** A full agent run: one user message in, one assistant reply out. */
export interface Trace {
  id: string;
  sessionId: string;
  /** The user message that triggered this run. */
  input: string;
  steps: TraceStep[];
  /** Total run time in milliseconds. */
  totalLatencyMs: number;
  /** RAG confidence for the run (0–1); below threshold triggers escalation. */
  confidence?: number;
  createdAt: string;
}

/** A single RAG retrieval hit, shown in the observability drawer. */
export interface RetrievalHit {
  id: string;
  source: string;
  snippet: string;
  score: number;
}

/** A recorded tool invocation, shown in the observability drawer. */
export interface ToolCallRecord {
  id: string;
  name: "orderLookup" | "initiateRefund" | "createTicket";
  args: Record<string, unknown>;
  result: unknown;
  latencyMs: number;
  createdAt: string;
}
