/**
 * The LangGraph agent graph (architecture-v2.md §5.1).
 *
 * ONE graph serves text AND voice turns. Nodes:
 *
 *   route_intent → retrieve_policies → pre_gate → plan_tools ⇄ tools_loop
 *   → generate_draft → verify_claims → stream_answer → END
 *   with escalate_node reachable from route / pre_gate / plan / tools /
 *   generate / verify.
 *
 * Terminal states: answer_ready, awaiting_user (clarification),
 * awaiting_confirmation (refund), escalated.
 *
 * Deterministic decisions are made in CODE, never by the model:
 * confirmation/denial detection, refund execution (the plan node issues
 * the phase-2 call itself — the model never decides to execute a refund),
 * chit-chat/other answers, escalation. The model proposes; code disposes.
 *
 * The graph never streams: it buffers the draft, verifies it, and returns
 * the final state. The chat route stream-replays the VERIFIED text (§3.2).
 */

import { END, START, StateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { CAVEAT_PREFIX, stage1Gate } from "@/lib/agent/evidence";
import {
  buildHandoffMessage,
  checkRepeatedFailure,
  OTHER_CUSTOMER_DATA_REFUSAL,
  runEscalateNode,
  type EscalationRule,
} from "@/lib/agent/escalation";
import {
  mockRoute,
  type Intent,
  type SensitiveCategory,
} from "@/lib/agent/model";
import {
  buildDraftSystem,
  buildPlanSystem,
  ROUTE_SYSTEM,
} from "@/lib/agent/prompts";
import {
  AgentStateAnnotation,
  type AgentState,
  type GraphConfig,
  type PendingAction,
} from "@/lib/agent/state";
import {
  SYSTEM_FAILURE_ESCALATION_COUNT,
  TOOL_MAX_ITERATIONS,
} from "@/lib/agent/thresholds";
import { verifyDraft, type Draft, type ToolCallForVerify } from "@/lib/agent/verify";
import { retrieve, getRetrievalSource } from "@/lib/rag/retrieve";
import { MODEL_TOOLS, executeTool } from "@/lib/tools/execute";
import { formatCents } from "@/lib/money";

function cfg(config: RunnableConfig): GraphConfig {
  return config.configurable as unknown as GraphConfig;
}

/** FNV-1a hash of (tool, args) — the "same request" key for system failures (§5.2). */
function hashToolCall(tool: string, args: Record<string, unknown>): string {
  const text = `${tool}:${JSON.stringify(args)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const CONFIRM_RE =
  /^\s*(yes|yeah|yep|confirm|confirmed|go ahead|do it|please (do it|proceed)|ok|okay|sure)\b/i;
const DENY_RE = /^\s*(no|nope|cancel|don't|never mind|stop|not now)\b/i;
const ORDER_ID_RE = /\bNW-\d{5}\b/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const CHITCHAT_ANSWER =
  "Hi there! I'm the Northwind Outfitters support assistant. I can help with returns, refunds, order tracking, and questions about our policies. What can I do for you?";
const THANKS_ANSWER =
  "You're welcome! Is there anything else I can help with?";
const OTHER_ANSWER =
  "I'm not sure how to help with that — could you tell me a bit more about what you need? I can help with returns, refunds, order status, and questions about our policies.";

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

async function routeIntent(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  const { model, embedder, trace } = cfg(config);

  // Already escalated: return the handoff message, never silently resume.
  if (state.sessionEscalated) {
    trace.emit("escalation", {
      rule: "already_escalated",
      note: "Session was escalated in an earlier turn; no new ticket created.",
    });
    return {
      finalAnswer:
        "Your request has already been handed to a human agent — they'll follow up shortly. If you have a new question, please start a new chat.",
      terminalState: "escalated",
    };
  }

  // Refund confirmation / denial — deterministic, not a model decision.
  const pending = state.pendingAction;
  if (pending?.type === "refund" && pending.confirmationToken) {
    if (CONFIRM_RE.test(state.userMessage)) {
      trace.emit("route", {
        intent: "refund",
        note: "User confirmed the pending refund (deterministic).",
      });
      return {
        intent: "refund",
        standaloneQuery: `refund order ${String(pending.slots.orderId ?? "")}`,
        refundConfirmation: "confirmed",
      };
    }
    if (DENY_RE.test(state.userMessage)) {
      trace.emit("route", {
        intent: "refund",
        note: "User declined the pending refund (deterministic).",
      });
      return {
        intent: "refund",
        pendingAction: null,
        refundConfirmation: "denied",
        finalAnswer:
          "No problem — I haven't processed any refund. Is there anything else I can help with?",
        terminalState: "answer_ready",
      };
    }
  }

  // Pending-action resume (§5.4): the user is answering a clarifying
  // question from an earlier turn. An order ID / email in the message
  // resumes the pending refund or order lookup deterministically — the
  // model must not re-route "Order NW-88412." to a policy question.
  if (pending?.type === "refund" && !pending.confirmationToken) {
    const orderId = state.userMessage.match(ORDER_ID_RE)?.[0]?.toUpperCase();
    const email = state.userMessage.match(EMAIL_RE)?.[0];
    if (orderId || email) {
      trace.emit("route", {
        intent: "refund",
        note: "Resuming pending refund with the order identifier the user provided.",
      });
      return {
        intent: "refund",
        standaloneQuery: orderId
          ? `refund order ${orderId}`
          : `refund order for ${email}`,
      };
    }
  }
  if (
    pending?.type === "clarification" &&
    pending.slots.intent === "order_status"
  ) {
    const orderId = state.userMessage.match(ORDER_ID_RE)?.[0]?.toUpperCase();
    const email = state.userMessage.match(EMAIL_RE)?.[0];
    if (orderId || email) {
      trace.emit("route", {
        intent: "order_status",
        note: "Resuming pending order lookup with the identifier the user provided.",
      });
      return {
        intent: "order_status",
        standaloneQuery: orderId
          ? `status of order ${orderId}`
          : `orders for ${email}`,
      };
    }
  }

  // One structured-output call: intent, sensitive flag, standalone query.
  let route: ReturnType<typeof mockRoute>;
  try {
    const result = await model.generate({
      system: ROUTE_SYSTEM,
      messages: [
        ...state.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: state.userMessage },
      ],
      task: "route",
      jsonMode: true,
    });
    route = JSON.parse(result.content) as ReturnType<typeof mockRoute>;
    if (typeof route.intent !== "string" || !route.standaloneQuery) {
      throw new Error("route result missing intent/standaloneQuery");
    }
  } catch (err) {
    // Fail open to retrieval + the gate (which escalates on weak evidence)
    // rather than failing the turn on a transient model error.
    console.error("[graph] route call failed, defaulting to policy_question:", err);
    route = {
      intent: "policy_question",
      sensitive: false,
      sensitiveCategory: null,
      standaloneQuery: state.userMessage,
    };
  }

  trace.emit("route", {
    intent: route.intent,
    sensitive: route.sensitive,
    sensitiveCategory: route.sensitiveCategory,
    standaloneQuery: route.standaloneQuery,
  });

  // Sensitive topics + explicit human requests escalate immediately.
  // EXCEPTION: another customer's data is REFUSED (no ticket) — §3.5.
  if (route.intent === "sensitive") {
    if (route.sensitiveCategory === "other_customer_data") {
      return {
        intent: "sensitive",
        sensitiveCategory: route.sensitiveCategory,
        standaloneQuery: route.standaloneQuery,
        finalAnswer: OTHER_CUSTOMER_DATA_REFUSAL,
        terminalState: "answer_ready",
      };
    }
    return {
      intent: "sensitive",
      sensitiveCategory: route.sensitiveCategory,
      standaloneQuery: route.standaloneQuery,
      escalation: { rule: "sensitive_topic" },
    };
  }
  if (route.intent === "human_request") {
    return {
      intent: "human_request",
      standaloneQuery: route.standaloneQuery,
      escalation: { rule: "explicit_request" },
    };
  }

  // Chit-chat / other: short direct answers, no policy claims, no retrieval.
  if (route.intent === "chit_chat") {
    const thanks = /thank/i.test(state.userMessage);
    return {
      intent: "chit_chat",
      standaloneQuery: route.standaloneQuery,
      finalAnswer: thanks ? THANKS_ANSWER : CHITCHAT_ANSWER,
      terminalState: "answer_ready",
    };
  }
  if (route.intent === "other") {
    return {
      intent: "other",
      standaloneQuery: route.standaloneQuery,
      finalAnswer: OTHER_ANSWER,
      terminalState: "answer_ready",
    };
  }

  // Repeated failure (trigger 5): 2 caveat turns, or re-ask + negative signal.
  if (
    route.intent === "policy_question" ||
    route.intent === "refund" ||
    route.intent === "complaint"
  ) {
    const repeated = await checkRepeatedFailure({
      recentTracks: state.recentTracks,
      lastUserMessages: state.lastUserMessages,
      currentMessage: state.userMessage,
      embedder,
    });
    if (repeated.repeated) {
      trace.emit("escalation", {
        rule: "repeated_failure",
        reason: repeated.reason,
      });
      return {
        intent: route.intent,
        standaloneQuery: route.standaloneQuery,
        escalation: { rule: "repeated_failure" },
      };
    }
  }

  return {
    intent: route.intent,
    sensitiveCategory: route.sensitiveCategory as SensitiveCategory | null,
    standaloneQuery: route.standaloneQuery,
  };
}

async function retrievePolicies(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  const { trace } = cfg(config);
  const query = state.standaloneQuery ?? state.userMessage;
  try {
    const { hits, source } = await retrieve(query);
    trace.emit("retrieval", {
      query,
      source,
      hits: hits.map((h) => ({
        chunkId: h.chunkId,
        policySlug: h.policySlug,
        section: h.section,
        similarity: h.similarity,
        source: h.source,
      })),
    });
    return { retrievedChunks: hits };
  } catch (err) {
    // Retrieval failure → zero evidence → the pre-gate escalates honestly
    // rather than the turn crashing.
    console.error("[graph] retrieval failed:", err);
    trace.emit("retrieval", {
      query,
      source: getRetrievalSource(),
      hits: [],
      error: "retrieval failed",
    });
    return { retrievedChunks: [] };
  }
}

function preGate(
  state: AgentState,
  config: RunnableConfig,
): Partial<AgentState> {
  const { trace } = cfg(config);
  const evidenceCheck = stage1Gate(
    (state.intent ?? "policy_question") as Intent,
    state.retrievedChunks,
  );
  trace.emit("evidence_check", {
    intent: evidenceCheck.intent,
    track: evidenceCheck.track,
    topSimilarity: evidenceCheck.topSimilarity,
    survivingChunks: evidenceCheck.survivingChunks,
    reason: evidenceCheck.reason,
  });
  if (evidenceCheck.track === "escalate") {
    return { evidenceCheck, escalation: { rule: "stage1_fail" } };
  }
  return { evidenceCheck };
}

async function planTools(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  const { model, trace } = cfg(config);

  // Confirmed refund: the NODE issues the phase-2 call deterministically.
  // The model never decides to execute a refund.
  if (
    state.refundConfirmation === "confirmed" &&
    state.pendingAction?.type === "refund" &&
    state.pendingAction.confirmationToken
  ) {
    const slots = state.pendingAction.slots;
    return {
      pendingToolCalls: [
        {
          id: `call_refund_${state.turnNumber}`,
          name: "initiateRefund",
          arguments: {
            orderId: slots.orderId,
            reason:
              typeof slots.reason === "string"
                ? slots.reason
                : "Customer confirmed refund.",
            confirmationToken: state.pendingAction.confirmationToken,
          },
        },
      ],
    };
  }

  // A refund already executed this turn → straight to the draft. Without
  // this, the plan step would re-ask for the order ID after executing.
  if (
    state.toolCalls.some(
      (t) =>
        t.tool === "initiateRefund" &&
        t.outcome === "ok" &&
        t.result.status === "initiated",
    )
  ) {
    return { pendingToolCalls: [] };
  }

  // An order already looked up this turn → straight to the draft. Without
  // this, the plan step re-issues the same orderLookup on every iteration
  // (observed live: 3 calls for one question), and each re-call is another
  // chance for a validation/system failure to trip the two-error
  // escalation. It also routes the answer through the VERIFIED draft
  // (generate_draft → verify_claims → answer_ready): the plan step must
  // never answer an order-status question in plain text, which bypasses
  // the verifier entirely and ends the turn in awaiting_user.
  if (
    state.intent === "order_status" &&
    state.toolCalls.some(
      (t) => t.tool === "orderLookup" && t.outcome === "ok",
    )
  ) {
    return { pendingToolCalls: [] };
  }

  const calledTools = state.toolCalls.map((t) => t.tool);
  const lastLookup = [...state.toolCalls]
    .reverse()
    .find((t) => t.tool === "orderLookup" && t.outcome === "ok");
  const system = buildPlanSystem({
    intent: (state.intent ?? "policy_question") as Intent,
    calledTools,
    orderLookupResult: lastLookup ? (lastLookup.result as Record<string, unknown>) : null,
    pendingAction: state.pendingAction,
    retrievedChunks: state.retrievedChunks.map((c) => ({
      policySlug: c.policySlug,
      section: c.section,
    })),
  });

  let result;
  try {
    result = await model.generate({
      system,
      messages: [
        ...state.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: state.userMessage },
      ],
      task: "plan",
      tools: MODEL_TOOLS,
    });
  } catch (err) {
    // One retry, then escalate (system errors prevented the request).
    console.error("[graph] plan call failed, retrying once:", err);
    try {
      result = await model.generate({
        system,
        messages: [{ role: "user" as const, content: state.userMessage }],
        task: "plan",
        tools: MODEL_TOOLS,
      });
    } catch (err2) {
      console.error("[graph] plan call failed twice, escalating:", err2);
      trace.emit("error", { node: "plan_tools", error: String(err2) });
      return { escalation: { rule: "tool_system_failure" } };
    }
  }

  // parallel_tool_calls is false — take the first call; extras are ignored
  // (and logged) rather than executed.
  if (result.toolCalls.length > 0) {
    if (result.toolCalls.length > 1) {
      trace.emit("error", {
        node: "plan_tools",
        note: `Model returned ${result.toolCalls.length} tool calls; executing only the first (parallel_tool_calls=false).`,
      });
    }
    if (state.toolIterations >= TOOL_MAX_ITERATIONS) {
      trace.emit("tool_budget_exhausted", {
        iterations: state.toolIterations,
        cap: TOOL_MAX_ITERATIONS,
      });
      return { escalation: { rule: "tool_budget_exhausted" } };
    }
    return { pendingToolCalls: [result.toolCalls[0]] };
  }

  // Plain-text reply from the plan step = a clarifying question — EXCEPT
  // for retrieval-gated intents (policy_question / complaint), where the
  // answer comes from the retrieved policy text via the VERIFIED draft.
  // Plan-step text bypasses the verifier entirely, so a model that answers
  // the policy question here streams an unverified answer (observed live:
  // "30 days" when the retrieved policy says 60). Discard the text and
  // generate from the chunks instead; only refund / order_status genuinely
  // need information from the user (e.g. the order number).
  if (result.content.trim().length > 0) {
    const intent = (state.intent ?? "policy_question") as Intent;
    if (intent === "policy_question" || intent === "complaint") {
      trace.emit("error", {
        node: "plan_tools",
        note: "Plan step returned plain text for a retrieval-gated intent; discarding it — the answer is generated from the retrieved policy text and verified before streaming.",
      });
      return { pendingToolCalls: [] };
    }
    trace.emit("awaiting_user", { question: result.content });
    const pendingAction: PendingAction | null =
      state.intent === "refund"
        ? { type: "refund", slots: state.pendingAction?.slots ?? {} }
        : state.intent === "order_status"
          ? { type: "clarification", slots: { intent: "order_status" } }
          : state.pendingAction;
    return {
      clarifyingQuestion: result.content,
      pendingAction,
      finalAnswer: result.content,
      terminalState: "awaiting_user",
    };
  }

  // No tools, no question — proceed to generation.
  return { pendingToolCalls: [] };
}

async function toolsLoop(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  const { store, trace } = cfg(config);
  const updates: Partial<AgentState> = {
    toolIterations: state.toolIterations + 1,
    pendingToolCalls: [],
  };
  const newToolCalls: AgentState["toolCalls"] = [];
  const failures: Record<string, number> = { ...state.systemFailures };

  for (const call of state.pendingToolCalls) {
    const startedAt = Date.now();
    trace.emit("tool_call", {
      tool: call.name,
      args: call.arguments,
      iteration: state.toolIterations + 1,
    });
    const result = await executeTool(call.name, call.arguments, {
      store,
      sessionId: state.sessionId,
      turnNumber: state.turnNumber,
      pendingConfirmationToken: state.pendingAction?.confirmationToken,
    });
    const latencyMs = Date.now() - startedAt;
    const record = {
      callId: call.id,
      tool: call.name,
      args: call.arguments,
      outcome: result.outcome,
      result: result.data,
      errorCode: result.errorCode,
      latencyMs,
      iteration: state.toolIterations + 1,
    };
    newToolCalls.push(record);
    trace.emit("tool_result", {
      tool: call.name,
      outcome: result.outcome,
      errorCode: result.errorCode,
      latencyMs,
    });
    // Write-ahead tool-call record (the side effect itself was already
    // written inside the tool, e.g. the refund row).
    try {
      await store.recordToolCall({
        sessionId: state.sessionId,
        turnNumber: state.turnNumber,
        callId: call.id,
        toolName: call.name,
        args: call.arguments,
        result: result.data,
        errorCode: result.errorCode ?? null,
      });
    } catch (err) {
      console.error("[graph] recordToolCall failed (non-fatal):", err);
    }

    // Refund proposed → pause for confirmation (terminal state).
    if (
      call.name === "initiateRefund" &&
      result.outcome === "ok" &&
      result.data.status === "REQUIRES_CONFIRMATION"
    ) {
      const amountDisplay =
        typeof result.data.amountDisplay === "string"
          ? result.data.amountDisplay
          : formatCents(Number(result.data.amountCents ?? 0));
      const orderId = String(result.data.orderId ?? "");
      trace.emit("awaiting_confirmation", {
        orderId,
        amountCents: result.data.amountCents,
      });
      return {
        ...updates,
        toolCalls: newToolCalls,
        pendingAction: {
          type: "refund",
          slots: {
            orderId,
            amountCents: result.data.amountCents,
            reason: result.data.reason,
          },
          confirmationToken: String(result.data.confirmationToken ?? ""),
        },
        finalAnswer: `Just to confirm — refund ${amountDisplay} for order ${orderId}? Reply yes to confirm, or no to cancel.`,
        terminalState: "awaiting_confirmation",
      };
    }

    // Refund executed (phase 2) → the pending action is consumed. Without
    // this, the next plan step would re-issue the phase-2 call.
    if (
      call.name === "initiateRefund" &&
      result.outcome === "ok" &&
      result.data.status === "initiated"
    ) {
      updates.pendingAction = null;
    }

    // Refund over $500 → escalation for human approval. The pendingAction
    // is KEPT so escalate_node can attach the confirmed request to the
    // ticket; escalate_node clears it after the ticket is created.
    if (result.errorCode === "REFUND_OVER_LIMIT") {
      return {
        ...updates,
        toolCalls: newToolCalls,
        refundOverLimit: true,
        escalation: { rule: "refund_over_500" },
      };
    }

    // System failures count toward the two-error trigger, keyed on
    // hash(tool, args). Business outcomes do not count.
    if (result.outcome === "system") {
      const key = hashToolCall(call.name, call.arguments);
      failures[key] = (failures[key] ?? 0) + 1;
      if (failures[key] >= SYSTEM_FAILURE_ESCALATION_COUNT) {
        return {
          ...updates,
          toolCalls: newToolCalls,
          systemFailures: failures,
          escalation: { rule: "tool_system_failure" },
        };
      }
    }
  }

  return { ...updates, toolCalls: newToolCalls, systemFailures: failures };
}

async function generateDraft(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  const { model, trace } = cfg(config);

  // Order status with a successful single-order lookup: the answer is
  // fully determined by the tool result, so build it in code (same wording
  // as the mock model) instead of asking the model to draft it. The real
  // model invents chunkIds for the claims when there are no retrieved
  // chunks (observed live: claims citing chunk "order_status"), which the
  // verifier rightly rejects — and the turn escalates (stage2_fail). A
  // code-built draft still flows through verify_claims below, so the
  // verified-answer guarantee holds; it just cannot hallucinate a
  // citation. Numbers come from the tool result, which the number assert
  // allows. Business outcomes (ORDER_NOT_FOUND) and email multi-order
  // lookups still go through the model draft, as before.
  if (state.intent === "order_status") {
    const lookup = [...state.toolCalls]
      .reverse()
      .find((t) => t.tool === "orderLookup" && t.outcome === "ok");
    const result = lookup?.result as
      | {
          orderId?: string;
          status?: string;
          items?: Array<{ name?: string; qty?: number }>;
          totalDisplay?: string;
          totalCents?: number;
          orders?: unknown;
        }
      | undefined;
    if (result?.orderId && result.status && !Array.isArray(result.orders)) {
      const items = Array.isArray(result.items)
        ? result.items
            .map((i) => `${i.name ?? "item"} (×${i.qty ?? 1})`)
            .join(", ")
        : "";
      const total =
        typeof result.totalDisplay === "string"
          ? result.totalDisplay
          : formatCents(Number(result.totalCents ?? 0));
      const answerText = `Order ${result.orderId} is ${result.status}. It contains ${items}, total ${total}.`;
      trace.emit("checking_policy", {
        note: "Order-status answer built deterministically from the tool result; running verification before anything streams.",
      });
      return { draft: { answerText, claims: [] } };
    }
  }

  const system = buildDraftSystem({
    intent: (state.intent ?? "policy_question") as Intent,
    chunks: state.retrievedChunks,
    toolCalls: state.toolCalls,
  });
  const messages = [
    ...state.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user" as const, content: state.userMessage },
  ];

  // One retry on a malformed draft, then escalate — a draft that cannot be
  // produced cannot be verified, so nothing streams to the user.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await model.generate({
        system,
        messages,
        task: "draft",
        jsonMode: true,
      });
      const draft = JSON.parse(result.content) as Draft;
      if (typeof draft.answerText !== "string" || !Array.isArray(draft.claims)) {
        throw new Error("draft missing answerText/claims");
      }
      trace.emit("checking_policy", {
        note: "Draft generated; running deterministic verification before anything streams.",
      });
      return { draft };
    } catch (err) {
      console.error(
        `[graph] draft attempt ${attempt + 1} failed:`,
        err instanceof Error ? err.message : err,
      );
      if (attempt === 1) {
        trace.emit("error", { node: "generate_draft", error: String(err) });
        return { escalation: { rule: "stage2_fail" } };
      }
    }
  }
  return { escalation: { rule: "stage2_fail" } };
}

function verifyClaims(
  state: AgentState,
  config: RunnableConfig,
): Partial<AgentState> {
  const { trace } = cfg(config);
  const draft = state.draft;
  if (!draft) {
    return { escalation: { rule: "stage2_fail" } };
  }
  const toolCalls: ToolCallForVerify[] = state.toolCalls.map((tc) => ({
    tool: tc.tool,
    outcome: tc.outcome,
    resultText: JSON.stringify(tc.result),
  }));
  const verifierResult = verifyDraft(draft, state.retrievedChunks, toolCalls);
  trace.emit("verifier", {
    passed: verifierResult.passed,
    failedAsserts: verifierResult.failedAsserts,
  });
  if (!verifierResult.passed) {
    // Draft withheld entirely — never shown to the user.
    return { verifierResult, escalation: { rule: "stage2_fail" } };
  }
  return { verifierResult };
}

function streamAnswer(state: AgentState): Partial<AgentState> {
  const draft = state.draft;
  if (!draft) {
    return { escalation: { rule: "stage2_fail" } };
  }
  const track = state.evidenceCheck?.track;
  const finalAnswer =
    track === "caveat" ? CAVEAT_PREFIX + draft.answerText : draft.answerText;
  return { finalAnswer, terminalState: "answer_ready" };
}

async function escalateNode(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  const { store, trace } = cfg(config);
  const rule: EscalationRule = state.escalation?.rule ?? "stage1_fail";
  const evidenceSummary = state.evidenceCheck
    ? `intent=${state.evidenceCheck.intent}, track=${state.evidenceCheck.track}, top-1=${state.evidenceCheck.topSimilarity?.toFixed(2) ?? "n/a"}, chunks=${state.evidenceCheck.survivingChunks}`
    : `intent=${state.intent ?? "unknown"}`;
  const summaryParts = [
    `User message: ${state.userMessage}`,
    rule === "refund_over_500" && state.pendingAction?.type === "refund"
      ? `Confirmed refund request: ${formatCents(Number(state.pendingAction.slots.amountCents ?? 0))} for order ${String(state.pendingAction.slots.orderId ?? "")} (user confirmed; needs human approval).`
      : null,
  ].filter(Boolean);
  const result = await runEscalateNode({
    store,
    sessionId: state.sessionId,
    turnNumber: state.turnNumber,
    rule,
    sensitiveCategory: state.sensitiveCategory,
    summary: summaryParts.join("\n"),
    evidenceSummary,
  });
  trace.emit("escalation", {
    rule,
    ticketId: result.ticketId,
    handoffPending: result.handoffPending,
  });
  return {
    escalation: { rule, ticketId: result.ticketId ?? undefined },
    pendingAction: null,
    finalAnswer: result.handoffMessage,
    terminalState: "escalated",
  };
}

// ---------------------------------------------------------------------------
// Graph assembly
// ---------------------------------------------------------------------------

export function buildGraph() {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("route_intent", routeIntent)
    .addNode("retrieve_policies", retrievePolicies)
    .addNode("pre_gate", preGate)
    .addNode("plan_tools", planTools)
    .addNode("tools_loop", toolsLoop)
    .addNode("generate_draft", generateDraft)
    .addNode("verify_claims", verifyClaims)
    .addNode("stream_answer", streamAnswer)
    .addNode("escalate_node", escalateNode)
    .addEdge(START, "route_intent")
    .addConditionalEdges("route_intent", (state) => {
      if (state.terminalState) return END;
      if (state.escalation) return "escalate_node";
      // Confirmed refunds still pass through retrieve + gate (the draft
      // needs the refund-timing chunk for its verified claims).
      if (
        state.intent === "policy_question" ||
        state.intent === "refund" ||
        state.intent === "complaint"
      ) {
        return "retrieve_policies";
      }
      return "plan_tools";
    })
    .addEdge("retrieve_policies", "pre_gate")
    .addConditionalEdges("pre_gate", (state) =>
      state.escalation ? "escalate_node" : "plan_tools",
    )
    .addConditionalEdges("plan_tools", (state) => {
      if (state.terminalState) return END;
      if (state.escalation) return "escalate_node";
      if (state.pendingToolCalls.length > 0) return "tools_loop";
      return "generate_draft";
    })
    .addConditionalEdges("tools_loop", (state) => {
      if (state.terminalState) return END;
      if (state.escalation) return "escalate_node";
      return "plan_tools";
    })
    .addConditionalEdges("generate_draft", (state) =>
      state.escalation ? "escalate_node" : "verify_claims",
    )
    .addConditionalEdges("verify_claims", (state) =>
      state.escalation ? "escalate_node" : "stream_answer",
    )
    .addEdge("stream_answer", END)
    .addEdge("escalate_node", END);
  return graph.compile();
}

// ---------------------------------------------------------------------------
// Turn runner — the entry point for the chat + voice transcript routes.
// ---------------------------------------------------------------------------

export interface RunTurnInput {
  store: NonNullable<GraphConfig["store"]>;
  model: NonNullable<GraphConfig["model"]>;
  embedder: NonNullable<GraphConfig["embedder"]>;
  sessionId: string;
  turnNumber: number;
  modality: "text" | "voice";
  userMessage: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  sessionSummary?: string;
  sessionEscalated?: boolean;
  pendingAction?: PendingAction | null;
  recentTracks?: Array<"answer" | "caveat" | "escalate">;
  lastUserMessages?: string[];
}

export interface RunTurnResult {
  state: AgentState;
  trace: ReturnType<import("@/lib/trace").TraceCollector["getEvents"]>;
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const { TraceCollector } = await import("@/lib/trace");
  const trace = new TraceCollector(input.turnNumber);
  const graph = buildGraph();
  const finalState = await graph.invoke(
    {
      messages: input.messages,
      sessionId: input.sessionId,
      turnNumber: input.turnNumber,
      modality: input.modality,
      userMessage: input.userMessage,
      sessionSummary: input.sessionSummary ?? "",
      sessionEscalated: input.sessionEscalated ?? false,
      pendingAction: input.pendingAction ?? null,
      recentTracks: input.recentTracks ?? [],
      lastUserMessages: input.lastUserMessages ?? [],
    },
    {
      configurable: {
        store: input.store,
        model: input.model,
        embedder: input.embedder,
        trace,
      },
    },
  );
  trace.emit("done", {
    terminalState: finalState.terminalState,
    totalLatencyMs: trace.totalLatencyMs,
  });
  return { state: finalState, trace: trace.getEvents() };
}
