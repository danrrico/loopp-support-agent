/**
 * Agent state (architecture-v2.md §5.1).
 *
 * One LangGraph state shape serves text AND voice turns. Operational state
 * lives in structured `pendingAction` — NEVER inside the prose session
 * summary (§7.2).
 *
 * DEVIATION FROM v2 (documented): refunds confirm via an explicit
 * `pendingAction` state machine, NOT LangGraph `interrupt()`. `interrupt`
 * needs a durable checkpointer (PostgresSaver) to survive across Vercel
 * instances; the pendingAction approach persists the confirmation in
 * `sessions.state` (Supabase or the demo store) and the next user message
 * resumes the flow deterministically. The terminal state
 * `awaiting_confirmation` marks the pause. Behavior is identical from the
 * user's side; the difference is only where the pause lives.
 *
 * Non-serializable collaborators (store, model, trace collector, embedder)
 * travel via the graph's `config.configurable`, not in state.
 */

import { Annotation } from "@langchain/langgraph";
import type { EvidenceCheck } from "@/lib/agent/evidence";
import type {
  Intent,
  SensitiveCategory,
  ChatModel,
} from "@/lib/agent/model";
import type { Draft, VerifyResult } from "@/lib/agent/verify";
import type { EscalationRule } from "@/lib/agent/escalation";
import type { SessionStore } from "@/lib/db/store";
import type { Embedder } from "@/lib/rag/embeddings";
import type { RetrievalHit } from "@/lib/rag/retrieve";
import type { TraceCollector } from "@/lib/trace";
import type { ToolOutcome } from "@/lib/tools/execute";

/** Terminal states (§5.1). `tool_budget_exhausted` always routes to `escalated`. */
export type TerminalState =
  | "answer_ready"
  | "awaiting_user"
  | "awaiting_confirmation"
  | "escalated";

/** Structured operational state — never inside the prose summary. */
export interface PendingAction {
  type: "refund" | "clarification";
  slots: Record<string, unknown>;
  confirmationToken?: string;
}

export interface ToolCallRecord {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: ToolOutcome;
  /** Serialized result data (or business-error data). */
  result: Record<string, unknown>;
  errorCode?: string;
  latencyMs: number;
  iteration: number;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export const AgentStateAnnotation = Annotation.Root({
  /** Conversation history for this turn (last 20 messages, §7.2). */
  messages: Annotation<ConversationMessage[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  sessionId: Annotation<string>,
  turnNumber: Annotation<number>,
  modality: Annotation<"text" | "voice">,
  /** The current user message. */
  userMessage: Annotation<string>,
  /** Prose session summary (context only — never holds operational state). */
  sessionSummary: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => "",
  }),
  /** True when the session was already escalated in an earlier turn. */
  sessionEscalated: Annotation<boolean>({
    reducer: (_a, b) => b,
    default: () => false,
  }),

  intent: Annotation<Intent | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  sensitiveCategory: Annotation<SensitiveCategory | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  standaloneQuery: Annotation<string | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  retrievedChunks: Annotation<RetrievalHit[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  evidenceCheck: Annotation<EvidenceCheck | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),

  toolCalls: Annotation<ToolCallRecord[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  toolIterations: Annotation<number>({
    reducer: (_a, b) => b,
    default: () => 0,
  }),
  /** System-failure counts keyed on hash(tool, args) (§5.2). */
  systemFailures: Annotation<Record<string, number>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  /** Set when a refund proposal exceeds the auto-execute limit. */
  refundOverLimit: Annotation<boolean>({
    reducer: (_a, b) => b,
    default: () => false,
  }),

  pendingAction: Annotation<PendingAction | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  escalation: Annotation<{ rule: EscalationRule; ticketId?: string } | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  draft: Annotation<Draft | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  verifierResult: Annotation<VerifyResult | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  clarifyingQuestion: Annotation<string | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  finalAnswer: Annotation<string | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  terminalState: Annotation<TerminalState | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),

  /** Evidence tracks of the last turns (repeated-failure detection). */
  recentTracks: Annotation<Array<"answer" | "caveat" | "escalate">>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  /** Last user messages (re-ask detection). */
  lastUserMessages: Annotation<string[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

/** Non-serializable collaborators, passed via graph config.configurable. */
export interface GraphConfig {
  store: SessionStore;
  model: ChatModel;
  embedder: Embedder;
  trace: TraceCollector;
}
