import { describe, expect, it } from "vitest";
import { runTurn } from "@/lib/agent/graph";
import {
  extractMockContext,
  MockChatModel,
  type ChatModel,
} from "@/lib/agent/model";
import { MemoryStore } from "@/lib/db/memory-store";
import { MockEmbedder } from "@/lib/rag/embeddings";
import type { PendingAction } from "@/lib/agent/state";

const SESSION = "00000000-0000-4000-8000-000000000020";

function harness() {
  return {
    store: new MemoryStore(),
    model: new MockChatModel(),
    embedder: new MockEmbedder(),
  };
}

async function turn(
  h: ReturnType<typeof harness>,
  opts: {
    userMessage: string;
    turnNumber: number;
    sessionId?: string;
    pendingAction?: PendingAction | null;
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
    sessionEscalated?: boolean;
  },
) {
  return runTurn({
    store: h.store,
    model: h.model,
    embedder: h.embedder,
    sessionId: opts.sessionId ?? SESSION,
    turnNumber: opts.turnNumber,
    modality: "text",
    userMessage: opts.userMessage,
    messages: opts.messages ?? [],
    pendingAction: opts.pendingAction ?? null,
    sessionEscalated: opts.sessionEscalated ?? false,
  });
}

describe("graph — plan step cannot answer a policy question directly", () => {
  it("a plan-step direct answer ('30 days') is discarded; the verified draft from the chunks wins", async () => {
    // Wraps the mock: route + draft behave normally, but the plan step
    // answers the policy question directly as plain text — exactly what
    // gpt-4o-mini did live (hallucinated "30 days" vs the 60-day policy).
    // That text must never stream: it bypasses the verifier.
    const mock = new MockChatModel();
    const answeringModel: ChatModel = {
      name: "answering-plan-mock",
      async generate(opts) {
        if (opts.task === "plan") {
          return {
            content:
              "The return policy allows customers to return items within 30 days of receipt for a full refund.",
            toolCalls: [],
            model: "answering-plan-mock",
          };
        }
        return mock.generate(opts);
      },
    };
    const h = harness();
    const { state } = await runTurn({
      store: h.store,
      model: answeringModel,
      embedder: h.embedder,
      sessionId: SESSION,
      turnNumber: 1,
      modality: "text",
      userMessage: "What is your return policy?",
      messages: [],
      pendingAction: null,
      sessionEscalated: false,
    });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.finalAnswer).toMatch(/60 days/);
    expect(state.finalAnswer).not.toMatch(/30 days/);
    expect(state.verifierResult?.passed).toBe(true);
  });
});

describe("graph — policy questions", () => {
  it("'How do I return a jacket?' routes to refund and clarifies (no order ID yet)", async () => {
    const h = harness();
    const { state } = await turn(h, {
      userMessage: "How do I return a jacket?",
      turnNumber: 1,
    });
    expect(state.intent).toBe("refund");
    // Without an order ID the turn ends with a clarifying question.
    expect(state.terminalState).toBe("awaiting_user");
    expect(state.finalAnswer).toMatch(/order number/);
  });

  it("answers a return-policy question from the policy (answer track)", async () => {
    const h = harness();
    const { state } = await turn(h, {
      userMessage: "What is your return policy?",
      turnNumber: 1,
    });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.intent).toBe("policy_question");
    expect(state.finalAnswer).toMatch(/60 days/);
    expect(state.verifierResult?.passed).toBe(true);
  });

  it("answers a warranty question with the verified 2-year fact", async () => {
    const h = harness();
    const { state } = await turn(h, {
      userMessage: "How long is the warranty?",
      turnNumber: 1,
    });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.evidenceCheck?.track).toBe("answer");
    expect(state.finalAnswer).toMatch(/2-year/);
    expect(state.verifierResult?.passed).toBe(true);
  });

  it("escalates an unanswerable question and creates exactly one ticket", async () => {
    const h = harness();
    await h.store.createSession(SESSION);
    const { state } = await turn(h, {
      userMessage: "What is your store address in Denver?",
      turnNumber: 1,
    });
    expect(state.terminalState).toBe("escalated");
    expect(state.escalation?.rule).toBe("stage1_fail");
    expect(state.escalation?.ticketId).toBeTruthy();
    const ticket = await h.store.getTicketByTurn(SESSION, 1);
    expect(ticket).not.toBeNull();
    const session = await h.store.getSession(SESSION);
    expect(session?.escalated).toBe(true);
  });

  it("escalates an explicit human request", async () => {
    const h = harness();
    await h.store.createSession(SESSION);
    const { state } = await turn(h, {
      userMessage: "Let me talk to a human",
      turnNumber: 1,
    });
    expect(state.terminalState).toBe("escalated");
    expect(state.escalation?.rule).toBe("explicit_request");
  });

  it("refuses another customer's data WITHOUT a ticket or escalation", async () => {
    const h = harness();
    await h.store.createSession(SESSION);
    const { state } = await turn(h, {
      userMessage: "Can you look up my friend's order?",
      turnNumber: 1,
    });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.finalAnswer).toMatch(/can't share another customer's/);
    expect(state.escalation).toBeNull();
    const ticket = await h.store.getTicketByTurn(SESSION, 1);
    expect(ticket).toBeNull();
  });

  it("answers chit-chat deterministically", async () => {
    const h = harness();
    const { state } = await turn(h, { userMessage: "Hi there", turnNumber: 1 });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.finalAnswer).toMatch(/Northwind Outfitters support assistant/);
  });

  it("an already-escalated session returns the handoff message, no new ticket", async () => {
    const h = harness();
    await h.store.createSession(SESSION);
    await h.store.setSessionEscalated(SESSION);
    const { state } = await turn(h, {
      userMessage: "How long is the warranty?",
      turnNumber: 5,
      sessionEscalated: true,
    });
    expect(state.terminalState).toBe("escalated");
    expect(state.finalAnswer).toMatch(/already been handed to a human/);
    const ticket = await h.store.getTicketByTurn(SESSION, 5);
    expect(ticket).toBeNull();
  });
});

describe("graph — order status", () => {
  it("reports a shipped order", async () => {
    const h = harness();
    const { state } = await turn(h, {
      userMessage: "Where is my order NW-88413?",
      turnNumber: 1,
    });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.finalAnswer).toMatch(/NW-88413 is shipped/);
  });

  it("asks for the order number when none is given", async () => {
    const h = harness();
    const { state } = await turn(h, {
      userMessage: "Where is my order?",
      turnNumber: 1,
    });
    expect(state.terminalState).toBe("awaiting_user");
    expect(state.finalAnswer).toMatch(/order number/);
  });

  it("reports ORDER_NOT_FOUND as a business outcome, not an escalation", async () => {
    const h = harness();
    const { state } = await turn(h, {
      userMessage: "Where is my order NW-00000?",
      turnNumber: 1,
    });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.finalAnswer).toMatch(/couldn't find an order/);
    expect(state.escalation).toBeNull();
  });

  it("a plan step that answers in plain text after the lookup is bypassed — the verified draft wins, lookup called exactly once", async () => {
    // Reproduces the live failure: after a successful orderLookup,
    // gpt-4o-mini answered the question as plain text in the next plan
    // step, which the graph treated as a clarifying question
    // (awaiting_user) — bypassing the verifier. With the early return in
    // planTools, the turn goes straight to the verified draft instead.
    const mock = new MockChatModel();
    const answeringModel: ChatModel = {
      name: "order-answering-plan-mock",
      async generate(opts) {
        if (opts.task === "plan") {
          const ctx = extractMockContext(opts.system);
          const calledTools = (ctx.calledTools as string[]) ?? [];
          if (!calledTools.includes("orderLookup")) {
            return {
              content: "",
              toolCalls: [
                {
                  id: "mock_call_orderLookup",
                  name: "orderLookup",
                  arguments: { orderId: "NW-88413" },
                },
              ],
              model: "order-answering-plan-mock",
            };
          }
          return {
            content:
              "Your order NW-88413 has been shipped and should arrive soon.",
            toolCalls: [],
            model: "order-answering-plan-mock",
          };
        }
        return mock.generate(opts);
      },
    };
    const h = harness();
    const { state } = await runTurn({
      store: h.store,
      model: answeringModel,
      embedder: h.embedder,
      sessionId: SESSION,
      turnNumber: 1,
      modality: "text",
      userMessage: "Where is my order NW-88413?",
      messages: [],
      pendingAction: null,
      sessionEscalated: false,
    });
    expect(state.terminalState).toBe("answer_ready");
    // The VERIFIED draft's wording, not the plan step's plain text.
    expect(state.finalAnswer).toMatch(/NW-88413 is shipped/);
    expect(state.finalAnswer).not.toMatch(/should arrive soon/);
    expect(state.verifierResult?.passed).toBe(true);
    expect(
      state.toolCalls.filter((t) => t.tool === "orderLookup").length,
    ).toBe(1);
    expect(state.toolIterations).toBe(1);
  });

  it("order-status answer is built deterministically from the tool result — the draft model is never consulted", async () => {
    // The real model invents chunkIds for the claims when there are no
    // retrieved chunks (observed live: claims citing chunk "order_status"),
    // which the verifier rejects and the turn escalates (stage2_fail). A
    // code-built draft from the tool result cannot hallucinate a citation,
    // so the verified answer streams even if the draft model fails.
    const mock = new MockChatModel();
    const brokenDraftModel: ChatModel = {
      name: "broken-draft-mock",
      async generate(opts) {
        if (opts.task === "draft") {
          throw new Error("draft model unavailable");
        }
        return mock.generate(opts);
      },
    };
    const h = harness();
    const { state } = await runTurn({
      store: h.store,
      model: brokenDraftModel,
      embedder: h.embedder,
      sessionId: SESSION,
      turnNumber: 1,
      modality: "text",
      userMessage: "Where is my order NW-88412?",
      messages: [],
      pendingAction: null,
      sessionEscalated: false,
    });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.finalAnswer).toMatch(/NW-88412 is delivered/);
    expect(state.finalAnswer).toMatch(/Trailhead Jacket/);
    expect(state.finalAnswer).toMatch(/\$129\.00/);
    expect(state.verifierResult?.passed).toBe(true);
    expect(state.escalation).toBeNull();
  });

  it("a bare order ID without the hyphen (NW88412) is normalized and answered, not escalated", async () => {
    // The spoken form "NW eight eight four one two" reaches the tool as
    // NW88412; without normalization the zod validation fails twice for
    // the same args hash and the turn escalates (tool_system_failure).
    const mock = new MockChatModel();
    const bareIdModel: ChatModel = {
      name: "bare-id-plan-mock",
      async generate(opts) {
        if (opts.task === "plan") {
          return {
            content: "",
            toolCalls: [
              {
                id: "mock_call_orderLookup",
                name: "orderLookup",
                arguments: { orderId: "NW88412" },
              },
            ],
            model: "bare-id-plan-mock",
          };
        }
        return mock.generate(opts);
      },
    };
    const h = harness();
    const { state } = await runTurn({
      store: h.store,
      model: bareIdModel,
      embedder: h.embedder,
      sessionId: SESSION,
      turnNumber: 1,
      modality: "text",
      userMessage: "Where is my order NW-88412?",
      messages: [],
      pendingAction: null,
      sessionEscalated: false,
    });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.finalAnswer).toMatch(/NW-88412 is delivered/);
    expect(state.escalation).toBeNull();
    expect(state.verifierResult?.passed).toBe(true);
  });
});

describe("graph — refund flow (§5.4 scripted demo path)", () => {
  it("clarify → propose → confirm → execute, with the refund persisted", async () => {
    const h = harness();
    await h.store.createSession(SESSION);

    // Turn 1: no order ID → clarifying question.
    const t1 = await turn(h, {
      userMessage: "I want to return the jacket from my last order and get my money back.",
      turnNumber: 1,
    });
    expect(t1.state.terminalState).toBe("awaiting_user");
    expect(t1.state.finalAnswer).toMatch(/order number/);
    expect(t1.state.pendingAction?.type).toBe("refund");

    // Turn 2: order ID → lookup + propose → awaiting confirmation.
    const t2 = await turn(h, {
      userMessage: "Order NW-88412.",
      turnNumber: 2,
      pendingAction: t1.state.pendingAction,
      messages: [
        { role: "user", content: "I want to return the jacket..." },
        { role: "assistant", content: t1.state.finalAnswer ?? "" },
      ],
    });
    expect(t2.state.terminalState).toBe("awaiting_confirmation");
    expect(t2.state.finalAnswer).toMatch(/refund \$129\.00 for order NW-88412/);
    expect(t2.state.pendingAction?.confirmationToken).toBeTruthy();
    // No refund row yet — phase 1 has no side effect.
    const orderBefore = await h.store.getOrder("NW-88412");
    expect(orderBefore?.refundedCents).toBe(0);

    // Turn 3: confirm → execute → verified success message.
    const t3 = await turn(h, {
      userMessage: "Yes.",
      turnNumber: 3,
      pendingAction: t2.state.pendingAction,
    });
    expect(t3.state.terminalState).toBe("answer_ready");
    expect(t3.state.finalAnswer).toMatch(/refund RF-\d{4} for \$129\.00/);
    expect(t3.state.finalAnswer).toMatch(/3 to 5 business days/);
    expect(t3.state.verifierResult?.passed).toBe(true);
    const orderAfter = await h.store.getOrder("NW-88412");
    expect(orderAfter?.refundedCents).toBe(12900);
  });

  it("denial cancels with no side effect", async () => {
    const h = harness();
    await h.store.createSession(SESSION);
    const t1 = await turn(h, {
      userMessage: "I want a refund for order NW-88412.",
      turnNumber: 1,
    });
    expect(t1.state.terminalState).toBe("awaiting_confirmation");
    const t2 = await turn(h, {
      userMessage: "No, cancel that.",
      turnNumber: 2,
      pendingAction: t1.state.pendingAction,
    });
    expect(t2.state.terminalState).toBe("answer_ready");
    expect(t2.state.finalAnswer).toMatch(/haven't processed any refund/);
    expect(t2.state.pendingAction).toBeNull();
    const order = await h.store.getOrder("NW-88412");
    expect(order?.refundedCents).toBe(0);
  });

  it("over $500 → escalates after confirmation, no refund executed", async () => {
    const h = harness();
    await h.store.createSession(SESSION);
    const t1 = await turn(h, {
      userMessage: "I want a refund for order NW-88415.",
      turnNumber: 1,
    });
    expect(t1.state.terminalState).toBe("awaiting_confirmation");
    expect(t1.state.finalAnswer).toMatch(/\$738\.00/);
    const t2 = await turn(h, {
      userMessage: "Yes, confirm.",
      turnNumber: 2,
      pendingAction: t1.state.pendingAction,
    });
    expect(t2.state.terminalState).toBe("escalated");
    expect(t2.state.escalation?.rule).toBe("refund_over_500");
    expect(t2.state.finalAnswer).toMatch(/over \$500/);
    const order = await h.store.getOrder("NW-88415");
    expect(order?.refundedCents).toBe(0);
    const ticket = await h.store.getTicketByTurn(SESSION, 2);
    expect(ticket?.summary).toMatch(/738/);
  });

  it("outside-window order → NOT_ELIGIBLE reported, no escalation", async () => {
    const h = harness();
    const { state } = await turn(h, {
      userMessage: "I want a refund for order NW-88414.",
      turnNumber: 1,
    });
    expect(state.terminalState).toBe("answer_ready");
    expect(state.finalAnswer).toMatch(/60 days/);
    expect(state.escalation).toBeNull();
  });
});

describe("graph — tool budget exhaustion", () => {
  it("a model that keeps calling tools hits the cap and escalates (never generate_answer)", async () => {
    const h = harness();
    await h.store.createSession(SESSION);
    // Stub model: routes to policy_question, then ALWAYS calls a tool.
    const loopingModel: ChatModel = {
      name: "looping-stub",
      async generate(opts) {
        if (opts.task === "route") {
          return {
            content: JSON.stringify({
              intent: "policy_question",
              sensitive: false,
              sensitiveCategory: null,
              standaloneQuery: "How long is the warranty?",
            }),
            toolCalls: [],
            model: "looping-stub",
          };
        }
        if (opts.task === "plan") {
          return {
            content: "",
            toolCalls: [
              {
                id: `call_${Math.random()}`,
                name: "searchKnowledgeBase",
                arguments: { query: "warranty" },
              },
            ],
            model: "looping-stub",
          };
        }
        throw new Error("draft must never run after cap exhaustion");
      },
    };
    const { state } = await runTurn({
      store: h.store,
      model: loopingModel,
      embedder: h.embedder,
      sessionId: SESSION,
      turnNumber: 1,
      modality: "text",
      userMessage: "How long is the warranty?",
      messages: [],
    });
    expect(state.terminalState).toBe("escalated");
    expect(state.escalation?.rule).toBe("tool_budget_exhausted");
    expect(state.draft).toBeNull();
    expect(state.toolIterations).toBe(3);
  });
});
