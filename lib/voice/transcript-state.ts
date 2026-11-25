/**
 * Pure transcript state for the voice panel — no React, no browser APIs,
 * so it is unit-testable (lib/voice/transcript-state.test.ts).
 *
 * Two invariants, both violated live 2026-11-25:
 *
 * 1. One utterance = one "You:" line, ever. Realtime transcription
 *    deltas are incremental chunks; the panel used to REPLACE the draft
 *    with each delta (showing only the last fragment) and a late partial
 *    arriving after the final re-appeared as a second dimmed line. The
 *    draft is now ACCUMULATED in place and cleared when the final lands.
 *    A final transcript whose item_id was already submitted is a
 *    duplicate delivery (double client / double event) and is dropped
 *    entirely — no second line, no second POST.
 *
 * 2. One agent response = one "Agent:" line. Output-audio-transcript
 *    deltas are also incremental; replacing the draft with each chunk
 *    rendered bare fragments ("that", "?") as standalone lines. Deltas
 *    are accumulated into the same draft line and only finalized when
 *    the response's transcript is done.
 *
 * Delta merge is prefix-aware: if a delta already contains the
 * accumulated text (some engines re-send cumulative text), replace
 * instead of appending, so neither shape double-prints.
 */

export class VoiceTranscriptState {
  private submittedItemIds = new Set<string>();
  private userDraft: { itemId: string; text: string } | null = null;
  private agentDraft = "";

  /** Merge an incremental delta into the accumulated text. */
  private static merge(accumulated: string, delta: string): string {
    if (!accumulated) return delta;
    if (!delta) return accumulated;
    // Cumulative re-send: the delta already contains everything so far.
    if (delta.startsWith(accumulated)) return delta;
    return accumulated + delta;
  }

  /**
   * Accumulate a user-transcription delta for one input item.
   * A delta for a new item starts a fresh draft. Returns the full draft.
   */
  accumulateUserPartial(itemId: string, delta: string): string {
    if (!this.userDraft || this.userDraft.itemId !== itemId) {
      this.userDraft = { itemId, text: delta };
    } else {
      this.userDraft = {
        itemId,
        text: VoiceTranscriptState.merge(this.userDraft.text, delta),
      };
    }
    return this.userDraft.text;
  }

  /** A new utterance started (speech_started) — drop any stale draft. */
  clearUserDraft(): void {
    this.userDraft = null;
  }

  /** Current user draft text ("" when none). */
  getUserDraft(): string {
    return this.userDraft?.text ?? "";
  }

  /**
   * True when this final transcript was already submitted — a duplicate
   * delivery of the same input item. The caller must drop it entirely:
   * no line, no POST. Empty itemIds cannot be deduped; they pass.
   */
  isDuplicateFinal(itemId: string): boolean {
    return itemId !== "" && this.submittedItemIds.has(itemId);
  }

  /** Record a final transcript as submitted (call only for non-duplicates). */
  markSubmitted(itemId: string): void {
    if (itemId !== "") this.submittedItemIds.add(itemId);
  }

  /** Reset submission tracking (new call / disconnect). */
  resetSubmitted(): void {
    this.submittedItemIds.clear();
  }

  /** Accumulate an agent output-transcript delta. Returns the full draft. */
  accumulateAgentPartial(delta: string): string {
    this.agentDraft = VoiceTranscriptState.merge(this.agentDraft, delta);
    return this.agentDraft;
  }

  /** A new agent response started — the next partials belong to it. */
  clearAgentDraft(): void {
    this.agentDraft = "";
  }

  /** Current agent draft text ("" when none). */
  getAgentDraft(): string {
    return this.agentDraft;
  }
}
