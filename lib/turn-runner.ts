/**
 * Shared turn orchestration for the chat + voice transcript routes
 * (architecture-v2.md §1.3, §5.1, §7).
 *
 * One entry point runs a turn end to end:
 *   load session + state snapshot → run the graph → save the state
 *   snapshot (optimistic version check) → return the result.
 *
 * Message + trace persistence does NOT gate the response — the routes
 * schedule it via Next.js `after()` (see the callers). The state snapshot
 * DOES gate it: a turn whose snapshot cannot persist reports an error
 * instead of an answer, because the next turn (e.g. a refund confirmation)
 * depends on it.
 *
 * Voice dedup: a transcript POST carries the Realtime `item_id`; the
 * runner stores the last 20 voice results in the session state and
 * returns the stored result for a duplicate item_id without re-running
 * the graph (a retried POST cannot double-execute a tool).
 */

import { getChatModel } from "@/lib/agent/model";
import { runTurn, type RunTurnResult } from "@/lib/agent/graph";
import type { EvidenceTrack } from "@/lib/agent/evidence";
import type { PendingAction } from "@/lib/agent/state";
import { getEmbedder } from "@/lib/rag/embeddings";
import { getStore, type SessionStore } from "@/lib/db/store";
import { withSessionLock } from "@/lib/session-lock";

/** Shape of the `sessions.state` JSONB snapshot. */
export interface SessionSnapshot {
  pendingAction: PendingAction | null;
  recentTracks: EvidenceTrack[];
  lastUserMessages: string[];
  turnNumber: number;
  voiceResults: Array<{
    itemId: string;
    turnNumber: number;
    speakableText: string;
    terminalState: string;
  }>;
}

const EMPTY_SNAPSHOT: SessionSnapshot = {
  pendingAction: null,
  recentTracks: [],
  lastUserMessages: [],
  turnNumber: 0,
  voiceResults: [],
};

function parseSnapshot(raw: Record<string, unknown>): SessionSnapshot {
  return {
    pendingAction: (raw.pendingAction as PendingAction | null) ?? null,
    recentTracks: (raw.recentTracks as EvidenceTrack[]) ?? [],
    lastUserMessages: (raw.lastUserMessages as string[]) ?? [],
    turnNumber: (raw.turnNumber as number) ?? 0,
    voiceResults: (raw.voiceResults as SessionSnapshot["voiceResults"]) ?? [],
  };
}

export interface AgentTurnInput {
  sessionId: string;
  userMessage: string;
  modality: "text" | "voice";
  /** Realtime item_id for voice dedup (omit for text turns). */
  itemId?: string;
  /** Override the store (tests). */
  store?: SessionStore;
}

export interface AgentTurnResult {
  /** "ran" = the graph executed; "duplicate" = voice dedup replay. */
  outcome: "ran" | "duplicate";
  turnNumber: number;
  /** Present when outcome is "ran". */
  run?: RunTurnResult;
  /** Present when outcome is "duplicate". */
  speakableText?: string;
  terminalState?: string;
}

export async function runAgentTurn(
  input: AgentTurnInput,
): Promise<AgentTurnResult> {
  const store = input.store ?? (await getStore());
  return withSessionLock(input.sessionId, async () => {
    // Load (or create) the session row + snapshot.
    let session = await store.getSession(input.sessionId);
    if (!session) {
      session = await store.createSession(input.sessionId);
    }
    const snapshot = parseSnapshot(session.state);

    // Voice dedup: a retried transcript POST replays the stored result.
    if (input.itemId) {
      const prior = snapshot.voiceResults.find(
        (r) => r.itemId === input.itemId,
      );
      if (prior) {
        return {
          outcome: "duplicate",
          turnNumber: prior.turnNumber,
          speakableText: prior.speakableText,
          terminalState: prior.terminalState,
        };
      }
    }

    const turnNumber = snapshot.turnNumber + 1;
    const history = await store.getMessages(input.sessionId, 20);

    const run = await runTurn({
      store,
      model: getChatModel(),
      embedder: getEmbedder(),
      sessionId: input.sessionId,
      turnNumber,
      modality: input.modality,
      userMessage: input.userMessage,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      sessionEscalated: session.escalated,
      pendingAction: snapshot.pendingAction,
      recentTracks: snapshot.recentTracks,
      lastUserMessages: snapshot.lastUserMessages,
    });

    // Persist the snapshot synchronously (version-checked). A conflict
    // means another instance ran a turn concurrently — report it instead
    // of an answer (the tool effects are idempotent; the user can retry).
    const track: EvidenceTrack =
      run.state.terminalState === "escalated"
        ? "escalate"
        : (run.state.evidenceCheck?.track ?? "answer");
    const nextSnapshot: SessionSnapshot = {
      pendingAction: run.state.pendingAction,
      recentTracks: [...snapshot.recentTracks, track].slice(-2),
      lastUserMessages: [...snapshot.lastUserMessages, input.userMessage].slice(
        -2,
      ),
      turnNumber,
      voiceResults:
        input.itemId && run.state.finalAnswer
          ? [
              ...snapshot.voiceResults,
              {
                itemId: input.itemId,
                turnNumber,
                speakableText: run.state.finalAnswer,
                terminalState: run.state.terminalState ?? "answer_ready",
              },
            ].slice(-20)
          : snapshot.voiceResults,
    };
    await store.saveSessionState(
      input.sessionId,
      nextSnapshot as unknown as Record<string, unknown>,
      session.version,
    );

    return { outcome: "ran", turnNumber, run };
  });
}
