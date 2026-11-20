/**
 * Chat model client — OpenAI-compatible, provider-swappable by env only
 * (architecture-v2.md §1.1, §11).
 *
 * - `MODEL_BASE_URL` (default https://api.openai.com/v1)
 * - `MODEL_API_KEY` (falls back to `OPENAI_API_KEY`)
 * - `MODEL_ID` (default gpt-4o-mini)
 *
 * The client speaks the OpenAI chat-completions request/response format, so
 * pointing at a different OpenAI-compatible provider is an env change, not
 * a code change. When no key is configured, `getChatModel()` returns the
 * deterministic `MockChatModel` — the app runs end to end with no key and
 * no network calls.
 *
 * The graph calls `generate()` with a `task` hint (route | plan | draft).
 * The OpenAI-compatible client ignores it (it just sends system + messages);
 * the mock uses it to pick its rule-based behavior. Generation is
 * non-streaming by design: the graph buffers the draft, verifies it, and
 * the chat route stream-replays the VERIFIED text (§3.2) — the model never
 * streams unverified tokens to the user.
 */

import { formatCents } from "@/lib/money";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface GenerateResult {
  /** Raw text content (may be "" when the model made tool calls). */
  content: string;
  toolCalls: ModelToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Model id that produced this result (for the drawer). */
  model: string;
}

export type ModelTask = "route" | "plan" | "draft";

export interface GenerateOptions {
  system: string;
  messages: ChatMessage[];
  /** Which graph task this call serves — the mock uses it; the real client ignores it. */
  task: ModelTask;
  tools?: ToolDefinition[];
  /** Request JSON output (response_format json_object). */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatModel {
  readonly name: string;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export function getModelConfig(): ModelConfig {
  return {
    baseUrl: (
      process.env.MODEL_BASE_URL ?? "https://api.openai.com/v1"
    ).replace(/\/$/, ""),
    apiKey: process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    modelId: process.env.MODEL_ID ?? "gpt-4o-mini",
  };
}

export function isModelConfigured(): boolean {
  return getModelConfig().apiKey.length > 0;
}

const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// OpenAI-compatible client (fetch-based, no SDK — keeps the provider swap
// a pure env change and avoids SDK version coupling).
// ---------------------------------------------------------------------------

export class OpenAICompatibleChatModel implements ChatModel {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: ModelConfig = getModelConfig()) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.name = config.modelId;
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: this.name,
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages,
      ],
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 1024,
    };
    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
      // A refund must never race its own lookup (§5.2).
      body.parallel_tool_calls = false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        `Model request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Never include the key or full provider body in the error.
      throw new Error(
        `Model request failed with HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const message = data.choices?.[0]?.message ?? {};
    const toolCalls: ModelToolCall[] = (message.tool_calls ?? []).map(
      (tc, i) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}") as Record<
            string,
            unknown
          >;
        } catch {
          // Malformed tool args are a system error — the graph counts them
          // toward the two-error trigger (§5.2). Surface them, don't swallow.
          throw new Error(
            `Model returned unparseable tool arguments for ${tc.function?.name ?? "unknown tool"}`,
          );
        }
        return {
          id: tc.id ?? `call_${i}`,
          name: tc.function?.name ?? "",
          arguments: args,
        };
      },
    );
    return {
      content: message.content ?? "",
      toolCalls,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : undefined,
      model: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock model — deterministic, rule-based, zero network. The fallback when
// no key is configured. It produces the same SHAPE as the real model
// (JSON for route/draft, tool calls for plan) so the graph, verifier, and
// drawer run identically against it.
// ---------------------------------------------------------------------------

export type Intent =
  | "policy_question"
  | "refund"
  | "order_status"
  | "complaint"
  | "human_request"
  | "sensitive"
  | "chit_chat"
  | "other";

export const SENSITIVE_CATEGORIES = [
  "legal_threat",
  "chargeback",
  "injury_safety",
  "fraud_stolen_card",
  "account_compromise",
  "other_customer_data",
  "medical_advice",
] as const;

export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

const SENSITIVE_PATTERNS: Array<{
  category: SensitiveCategory;
  pattern: RegExp;
}> = [
  { category: "legal_threat", pattern: /\b(lawsuit|sue you|my lawyer|attorney|legal action)\b/i },
  { category: "chargeback", pattern: /\b(chargeback|dispute (the |this )?charge|reverse the charge)\b/i },
  { category: "injury_safety", pattern: /\b(injur|hurt myself|hospital|burn|cut myself|unsafe|dangerous)\b/i },
  { category: "fraud_stolen_card", pattern: /\b(stolen card|stole my card|fraud|unauthorized charge|someone used my card)\b/i },
  { category: "account_compromise", pattern: /\b(hacked|someone (accessed|broke into)|unauthorized access|compromised)\b/i },
  { category: "other_customer_data", pattern: /\b(someone else'?s|another customer'?s|my (friend|neighbor|wife|husband)'?s) (order|account|address|email|phone|info)/i },
  { category: "medical_advice", pattern: /\b(medical|doctor|prescription|rash|allergic reaction|should i take)\b/i },
];

const HUMAN_PATTERNS = /\b(human|real person|agent|representative|talk to someone|someone real|escalate)\b/i;
const REFUND_PATTERNS = /\b(refund|return|money back|give me my money)\b/i;
const ORDER_PATTERNS = /\b(track|tracking|where is my order|order status|shipped|delivered|has my order|when will (it|my order) arrive)\b/i;
const COMPLAINT_PATTERNS = /\b(angry|terrible|awful|worst|disappointed|unacceptable|ridiculous|furious)\b/i;
const CHITCHAT_PATTERNS = /^(hi|hello|hey|thanks|thank you|bye|goodbye|good morning|good afternoon)\b/i;

export interface RouteResult {
  intent: Intent;
  sensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
  standaloneQuery: string;
}

/** Deterministic intent classification (mock routing). Pure function — unit-tested. */
export function mockRoute(message: string): RouteResult {
  const text = message.trim();
  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        intent: "sensitive",
        sensitive: true,
        sensitiveCategory: category,
        standaloneQuery: text,
      };
    }
  }
  if (HUMAN_PATTERNS.test(text)) {
    return {
      intent: "human_request",
      sensitive: false,
      sensitiveCategory: null,
      standaloneQuery: text,
    };
  }
  if (REFUND_PATTERNS.test(text)) {
    return {
      intent: "refund",
      sensitive: false,
      sensitiveCategory: null,
      standaloneQuery: text,
    };
  }
  if (ORDER_PATTERNS.test(text)) {
    return {
      intent: "order_status",
      sensitive: false,
      sensitiveCategory: null,
      standaloneQuery: text,
    };
  }
  if (COMPLAINT_PATTERNS.test(text)) {
    return {
      intent: "complaint",
      sensitive: false,
      sensitiveCategory: null,
      standaloneQuery: text,
    };
  }
  if (CHITCHAT_PATTERNS.test(text) && text.length < 60) {
    return {
      intent: "chit_chat",
      sensitive: false,
      sensitiveCategory: null,
      standaloneQuery: text,
    };
  }
  return {
    intent: "policy_question",
    sensitive: false,
    sensitiveCategory: null,
    standaloneQuery: text,
  };
}

/**
 * The graph passes structured context to the mock inside the system prompt
 * as a JSON block after a `---CONTEXT---` marker (the real model receives
 * the same context as prose; the mock reads the JSON). This keeps one
 * prompt-building path for both models.
 */
export function extractMockContext(system: string): Record<string, unknown> {
  const marker = "---CONTEXT---";
  const idx = system.indexOf(marker);
  if (idx === -1) return {};
  try {
    return JSON.parse(system.slice(idx + marker.length)) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

const ORDER_ID_RE = /\bNW-\d{5}\b/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export class MockChatModel implements ChatModel {
  readonly name = "mock";

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const lastUser =
      [...opts.messages].reverse().find((m) => m.role === "user")?.content ??
      "";
    if (opts.task === "route") {
      return {
        content: JSON.stringify(mockRoute(lastUser)),
        toolCalls: [],
        model: this.name,
      };
    }
    if (opts.task === "plan") {
      return this.plan(opts, lastUser);
    }
    return this.draft(opts);
  }

  private plan(
    opts: GenerateOptions,
    lastUser: string,
  ): GenerateResult {
    const ctx = extractMockContext(opts.system);
    const intent = ctx.intent as Intent | undefined;
    const calledTools = (ctx.calledTools as string[]) ?? [];
    const orderLookupResult = ctx.orderLookupResult as
      | { orderId?: string; status?: string; refundableCents?: number }
      | undefined;
    const pendingAction = ctx.pendingAction as
      | { type?: string; slots?: Record<string, unknown> }
      | null
      | undefined;

    const orderId = lastUser.match(ORDER_ID_RE)?.[0]?.toUpperCase();
    const email = lastUser.match(EMAIL_RE)?.[0];
    const knownOrderId =
      orderId ??
      (typeof pendingAction?.slots?.orderId === "string"
        ? (pendingAction.slots.orderId as string)
        : undefined);

    // Refund / order intents need an order first.
    if (
      (intent === "refund" || intent === "order_status") &&
      !calledTools.includes("orderLookup")
    ) {
      if (knownOrderId) {
        return {
          content: "",
          toolCalls: [
            {
              id: "mock_call_orderLookup",
              name: "orderLookup",
              arguments: { orderId: knownOrderId },
            },
          ],
          model: this.name,
        };
      }
      if (email) {
        return {
          content: "",
          toolCalls: [
            {
              id: "mock_call_orderLookup",
              name: "orderLookup",
              arguments: { email },
            },
          ],
          model: this.name,
        };
      }
      // No identifier — ask the user (clarifying question, awaiting_user).
      return {
        content:
          intent === "refund"
            ? "I'd be happy to help with that refund. What's the order number? It looks like NW-88412, and you can find it in your order confirmation email."
            : "Sure — what's the order number? It looks like NW-88412, and you can find it in your order confirmation email. Or I can look it up by the email address on the order.",
        toolCalls: [],
        model: this.name,
      };
    }

    // Refund with a looked-up, eligible order → propose the refund (phase 1).
    if (
      intent === "refund" &&
      orderLookupResult?.orderId &&
      !calledTools.includes("initiateRefund")
    ) {
      return {
        content: "",
        toolCalls: [
          {
            id: "mock_call_initiateRefund",
            name: "initiateRefund",
            arguments: {
              orderId: orderLookupResult.orderId,
              reason: "Customer requested a return and refund.",
            },
          },
        ],
        model: this.name,
      };
    }

    // Nothing to call — proceed to generation.
    return { content: "", toolCalls: [], model: this.name };
  }

  private draft(opts: GenerateOptions): GenerateResult {
    const ctx = extractMockContext(opts.system);
    const chunks = (ctx.chunks as Array<{ chunkId: string; content: string }>) ?? [];
    const toolResults = (ctx.toolResults as Array<Record<string, unknown>>) ?? [];
    const intent = ctx.intent as Intent | undefined;

    // Refund executed → success message. Numbers come from the tool result
    // (allowed by the number assert); timing comes from the billing chunk.
    const refundResult = toolResults.find(
      (r) => r.tool === "initiateRefund" && r.status === "initiated",
    );
    if (refundResult) {
      const amount = formatCents(Number(refundResult.amountCents ?? 0));
      const refundId = String(refundResult.refundId ?? "");
      const timingChunk = chunks.find((c) =>
        c.content.includes("3 to 5 business days"),
      );
      const claims = timingChunk
        ? [
            {
              text: "Refunds are issued within 3 to 5 business days after inspection.",
              chunkId: timingChunk.chunkId,
              quote: firstSentenceContaining(
                timingChunk.content,
                "3 to 5 business days",
              ),
            },
          ]
        : [];
      return {
        content: JSON.stringify({
          answerText: `Done — refund ${refundId} for ${amount} is on its way to your original payment method. Refunds are issued within 3 to 5 business days after inspection.`,
          claims,
        }),
        toolCalls: [],
        model: this.name,
      };
    }

    // Order lookup result → status answer. Numbers come from the tool result.
    const lookupResult = toolResults.find((r) => r.tool === "orderLookup");
    if (lookupResult && intent === "order_status") {
      if (lookupResult.error === "ORDER_NOT_FOUND") {
        return {
          content: JSON.stringify({
            answerText:
              "I couldn't find an order with that number. Could you double-check the order number? It looks like NW-88412.",
            claims: [],
          }),
          toolCalls: [],
          model: this.name,
        };
      }
      const items = Array.isArray(lookupResult.items)
        ? (lookupResult.items as Array<{ name?: string; qty?: number }>)
            .map((i) => `${i.name ?? "item"} (×${i.qty ?? 1})`)
            .join(", ")
        : "";
      const total = formatCents(Number(lookupResult.totalCents ?? 0));
      return {
        content: JSON.stringify({
          answerText: `Order ${lookupResult.orderId} is ${lookupResult.status}. It contains ${items}, total ${total}.`,
          claims: [],
        }),
        toolCalls: [],
        model: this.name,
      };
    }

    // Policy answer: quote the top chunk's most relevant sentences verbatim.
    // Verbatim quotes pass the quote-substring assert by construction, and
    // every number in the answer comes from the chunk itself.
    if (chunks.length > 0) {
      const top = chunks[0];
      const sentences = splitSentences(top.content);
      const answerSentences = sentences.slice(0, 2);
      const answerText = answerSentences.join(" ");
      return {
        content: JSON.stringify({
          answerText,
          claims: answerSentences.map((s) => ({
            text: s,
            chunkId: top.chunkId,
            quote: s,
          })),
        }),
        toolCalls: [],
        model: this.name,
      };
    }

    // No evidence — the graph should have escalated before drafting; this is
    // a defensive fallback, never a confident answer.
    return {
      content: JSON.stringify({
        answerText:
          "I don't have enough information in our policies to answer that confidently. Let me connect you with a human agent who can help.",
        claims: [],
      }),
      toolCalls: [],
      model: this.name,
    };
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function firstSentenceContaining(text: string, needle: string): string {
  return (
    splitSentences(text).find((s) => s.includes(needle)) ?? text.slice(0, 200)
  );
}

/** Factory: real OpenAI-compatible client when a key is configured, mock otherwise. */
export function getChatModel(): ChatModel {
  const config = getModelConfig();
  if (config.apiKey) return new OpenAICompatibleChatModel(config);
  return new MockChatModel();
}
