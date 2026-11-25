"use client";

import { useMemo, useState } from "react";
import type { TraceEvent, TurnTrace } from "@/lib/client/types";
import { trackOfTrace } from "@/lib/client/types";

type Track = "answer" | "caveat" | "escalate";

const DOT: Record<Track, string> = {
  answer: "bg-green-500",
  caveat: "bg-amber-500",
  escalate: "bg-red-500",
};

function TrackDot({ track }: { track: Track | null }) {
  if (!track) return <span className="inline-block h-2 w-2 rounded-full bg-zinc-300" />;
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${DOT[track]}`}
      title={`Evidence check: ${track}`}
    />
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {title}
      </h3>
      <div className="mt-2 space-y-2 text-xs">{children}</div>
    </section>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded bg-zinc-100 p-2 font-mono text-[11px] dark:bg-zinc-900">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Detail view for one turn's trace. */
function TurnDetail({ trace }: { trace: TraceEvent[] }) {
  const route = trace.find((e) => e.type === "route");
  const retrieval = trace.find((e) => e.type === "retrieval");
  const evidence = [...trace].reverse().find((e) => e.type === "evidence_check");
  const verifier = trace.find((e) => e.type === "verifier");
  const escalation = trace.find((e) => e.type === "escalation");
  const budget = trace.find((e) => e.type === "tool_budget_exhausted");
  const awaitingConfirmation = trace.find(
    (e) => e.type === "awaiting_confirmation",
  );
  const awaitingUser = trace.find((e) => e.type === "awaiting_user");
  const done = trace.find((e) => e.type === "done");
  const error = trace.find((e) => e.type === "error");

  // Pair tool_call / tool_result events in order.
  const toolPairs: Array<{
    call: TraceEvent;
    result?: TraceEvent;
  }> = [];
  for (const e of trace) {
    if (e.type === "tool_call") toolPairs.push({ call: e });
    else if (e.type === "tool_result" && toolPairs.length > 0) {
      toolPairs[toolPairs.length - 1].result = e;
    }
  }

  const hits = (retrieval?.payload.hits as Array<{
    chunkId: string;
    policySlug: string;
    section: string;
    similarity: number;
    source?: string;
  }>) ?? [];

  // Which corpus answered this query — Supabase policy_chunks in
  // production, the local corpus in demo mode. Named on the retrieval
  // event by the server so RAG-on-Supabase is provable from the drawer.
  const retrievalSource =
    typeof retrieval?.payload.source === "string"
      ? retrieval.payload.source
      : hits[0]?.source ?? "unknown";
  const retrievalSourceLabel =
    retrievalSource === "supabase:policy_chunks"
      ? "Supabase · policy_chunks"
      : retrievalSource === "local:policy_corpus"
        ? "Local corpus"
        : retrievalSource;

  return (
    <div className="space-y-3">
      {route && (
        <Section title="Route">
          <p>
            Intent: <span className="font-mono">{String(route.payload.intent)}</span>
          </p>
          {route.payload.sensitive ? (
            <p className="text-red-600">
              Sensitive: {String(route.payload.sensitiveCategory)}
            </p>
          ) : null}
          <p className="text-zinc-500 dark:text-zinc-400">
            Query: {String(route.payload.standaloneQuery ?? "")}
          </p>
          {typeof route.payload.note === "string" && (
            <p className="italic text-zinc-500 dark:text-zinc-400">
              {route.payload.note}
            </p>
          )}
        </Section>
      )}

      {retrieval && (
        <Section
          title={`Retrieval · ${retrievalSourceLabel} (${hits.length} chunks survived the floor)`}
        >
          {hits.length === 0 ? (
            <p className="text-zinc-500 dark:text-zinc-400">
              Zero surviving chunks — the pre-gate escalates policy intents.
            </p>
          ) : (
            hits.map((h) => (
              <div key={h.chunkId} className="flex justify-between gap-2">
                <span className="font-mono">
                  {h.policySlug} — {h.section}
                </span>
                <span className="shrink-0 font-mono">
                  {h.similarity.toFixed(2)}
                </span>
              </div>
            ))
          )}
        </Section>
      )}

      {evidence && (
        <Section title="Evidence check (Stage 1)">
          <p>
            Track:{" "}
            <span className="font-mono">{String(evidence.payload.track)}</span>{" "}
            <TrackDot track={trackOfTrace([evidence])} />
          </p>
          <p>
            Top-1 similarity:{" "}
            {typeof evidence.payload.topSimilarity === "number"
              ? evidence.payload.topSimilarity.toFixed(2)
              : "n/a (no retrieval gate)"}
          </p>
          <p>{String(evidence.payload.reason ?? "")}</p>
        </Section>
      )}

      {toolPairs.length > 0 && (
        <Section title={`Tool calls (${toolPairs.length})`}>
          {toolPairs.map((pair, i) => (
            <div key={i} className="border-b border-zinc-100 pb-2 last:border-0 dark:border-zinc-800">
              <p>
                <span className="font-mono font-semibold">
                  {String(pair.call.payload.tool)}
                </span>{" "}
                <span className="text-zinc-500">
                  (iteration {String(pair.call.payload.iteration ?? "?")})
                </span>
              </p>
              <JsonBlock value={pair.call.payload.args} />
              {pair.result && (
                <p>
                  Outcome:{" "}
                  <span className="font-mono">
                    {String(pair.result.payload.outcome)}
                  </span>
                  {pair.result.payload.errorCode
                    ? ` (${String(pair.result.payload.errorCode)})`
                    : ""}{" "}
                  · {String(pair.result.payload.latencyMs ?? "?")}ms
                </p>
              )}
            </div>
          ))}
        </Section>
      )}

      {verifier && (
        <Section title="Verifier (Stage 2 — deterministic)">
          <p>
            {verifier.payload.passed === true ? (
              <span className="text-green-600">Passed — draft released.</span>
            ) : (
              <span className="text-red-600">
                Failed — draft withheld, never shown.
              </span>
            )}
          </p>
          {Array.isArray(verifier.payload.failedAsserts) &&
            (verifier.payload.failedAsserts as string[]).map((a) => (
              <p key={a} className="font-mono text-[11px] text-red-600">
                {a}
              </p>
            ))}
        </Section>
      )}

      {awaitingConfirmation && (
        <Section title="Awaiting confirmation">
          <p>
            Refund{" "}
            {String(
              (awaitingConfirmation.payload.amountCents as number) / 100,
            )}{" "}
            USD for order {String(awaitingConfirmation.payload.orderId)} —
            the user must reply yes before anything executes.
          </p>
        </Section>
      )}

      {awaitingUser && (
        <Section title="Awaiting user">
          <p>Clarifying question sent; the turn waits for the user.</p>
        </Section>
      )}

      {budget && (
        <Section title="Tool budget exhausted">
          <p>
            {String(budget.payload.iterations)} iterations hit the cap of{" "}
            {String(budget.payload.cap)} — routed to escalation, never
            generated an answer from partial results.
          </p>
        </Section>
      )}

      {escalation && (
        <Section title="Escalation">
          <p>
            Rule:{" "}
            <span className="font-mono">{String(escalation.payload.rule)}</span>
          </p>
          {escalation.payload.ticketId ? (
            <p>
              Ticket:{" "}
              <span className="font-mono">
                {String(escalation.payload.ticketId)}
              </span>
            </p>
          ) : null}
          {escalation.payload.handoffPending === true && (
            <p className="text-amber-600">
              Ticket creation failed — the handoff is queued, not claimed.
            </p>
          )}
        </Section>
      )}

      {error && (
        <Section title="Error">
          <p className="text-red-600">{String(error.payload.error ?? "Unknown error")}</p>
        </Section>
      )}

      {done && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Turn complete in {String(done.payload.totalLatencyMs ?? "?")}ms.
        </p>
      )}
    </div>
  );
}

export function ObservabilityDrawer({
  traces,
  liveTrace,
  liveTurnNumber,
  onClose,
}: {
  /** Completed turns, oldest first. */
  traces: TurnTrace[];
  /** Events of the turn currently streaming (null when idle). */
  liveTrace: TraceEvent[] | null;
  liveTurnNumber: number | null;
  onClose: () => void;
}) {
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null);

  const visibleTurns = useMemo(() => {
    const list = [...traces];
    if (liveTrace && liveTurnNumber !== null) {
      list.push({ turnNumber: liveTurnNumber, trace: liveTrace, partial: true });
    }
    return list;
  }, [traces, liveTrace, liveTurnNumber]);

  const selected =
    selectedTurn === null
      ? visibleTurns[visibleTurns.length - 1]
      : visibleTurns.find((t) => t.turnNumber === selectedTurn);

  const totals = useMemo(() => {
    let escalations = 0;
    let toolCalls = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let anyPartial = false;
    for (const t of visibleTurns) {
      if (t.partial) anyPartial = true;
      for (const e of t.trace) {
        if (e.type === "escalation") escalations += 1;
        if (e.type === "tool_call") toolCalls += 1;
        if (e.type === "done" && typeof e.payload.totalLatencyMs === "number") {
          latencySum += e.payload.totalLatencyMs;
          latencyCount += 1;
        }
      }
    }
    return {
      turns: visibleTurns.length,
      escalations,
      toolCalls,
      avgLatency:
        latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
      anyPartial,
    };
  }, [visibleTurns]);

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Observability</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close observability drawer"
          className="rounded-full px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          ✕
        </button>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        Everything here comes from structured trace events emitted by the
        server. The word &ldquo;confidence&rdquo; is deliberately absent —
        the system reports the evidence it had and what it verified.
      </p>

      {/* Turn history */}
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Turn history
        </h3>
        {visibleTurns.length === 0 ? (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            No turns yet. Send a message to see its trace.
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {[...visibleTurns].reverse().map((t) => {
              const track = trackOfTrace(t.trace);
              const toolCount = t.trace.filter((e) => e.type === "tool_call").length;
              const done = t.trace.find((e) => e.type === "done");
              const latency =
                done && typeof done.payload.totalLatencyMs === "number"
                  ? `${done.payload.totalLatencyMs}ms`
                  : "…";
              const isSelected =
                selected?.turnNumber === t.turnNumber;
              return (
                <li key={t.turnNumber}>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedTurn(
                        isSelected ? null : t.turnNumber,
                      )
                    }
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                      isSelected ? "bg-zinc-100 dark:bg-zinc-800" : ""
                    }`}
                  >
                    <TrackDot track={track} />
                    <span className="font-mono">Turn {t.turnNumber}</span>
                    <span className="text-zinc-500">
                      {toolCount} tool{toolCount === 1 ? "" : "s"} · {latency}
                    </span>
                    {t.partial && (
                      <span className="ml-auto rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                        partial
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Selected turn detail */}
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {selected
            ? `Turn ${selected.turnNumber} detail`
            : "Turn detail"}
        </h3>
        <div className="mt-2">
          {selected ? (
            <TurnDetail trace={selected.trace} />
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Select a turn to inspect its trace.
            </p>
          )}
        </div>
      </div>

      {/* Session totals */}
      <div className="mt-auto border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:text-zinc-400">
        <p>
          {totals.turns} turn{totals.turns === 1 ? "" : "s"} ·{" "}
          {totals.escalations} escalation{totals.escalations === 1 ? "" : "s"} ·{" "}
          {totals.toolCalls} tool call{totals.toolCalls === 1 ? "" : "s"}
          {totals.avgLatency !== null
            ? ` · avg ${totals.avgLatency}ms`
            : ""}
          {totals.anyPartial && (
            <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900 dark:text-amber-200">
              partial data
            </span>
          )}
        </p>
      </div>
    </aside>
  );
}
