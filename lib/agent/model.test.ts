import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getModelConfig,
  MockChatModel,
  mockRoute,
  OpenAICompatibleChatModel,
} from "@/lib/agent/model";

describe("mockRoute — deterministic intent classification", () => {
  it("refund intent", () => {
    expect(mockRoute("I want to return the jacket and get my money back").intent).toBe("refund");
    expect(mockRoute("Can I get a refund for order NW-88412?").intent).toBe("refund");
  });

  it("order_status intent", () => {
    expect(mockRoute("Where is my order?").intent).toBe("order_status");
    expect(mockRoute("Has my order shipped yet?").intent).toBe("order_status");
  });

  it("human_request intent", () => {
    expect(mockRoute("Let me talk to a human").intent).toBe("human_request");
    expect(mockRoute("I want to speak to a real person").intent).toBe("human_request");
  });

  it("sensitive categories", () => {
    expect(mockRoute("I'm going to sue you").sensitiveCategory).toBe("legal_threat");
    expect(mockRoute("I'll just do a chargeback").sensitiveCategory).toBe("chargeback");
    expect(mockRoute("Someone stole my card and ordered things").sensitiveCategory).toBe("fraud_stolen_card");
    expect(mockRoute("My account was hacked").sensitiveCategory).toBe("account_compromise");
    expect(mockRoute("Can you look up my friend's order?").sensitiveCategory).toBe("other_customer_data");
  });

  it("chit_chat for short greetings", () => {
    expect(mockRoute("Hi there").intent).toBe("chit_chat");
    expect(mockRoute("Thanks!").intent).toBe("chit_chat");
  });

  it("policy_question is the default", () => {
    expect(mockRoute("How long is the warranty?").intent).toBe("policy_question");
    expect(mockRoute("How much does express shipping cost?").intent).toBe("policy_question");
  });
});

describe("MockChatModel", () => {
  const model = new MockChatModel();

  it("route task returns JSON with intent + standalone query", async () => {
    const r = await model.generate({
      system: "route",
      messages: [{ role: "user", content: "How do I return a jacket?" }],
      task: "route",
      jsonMode: true,
    });
    expect(JSON.parse(r.content).intent).toBe("refund");
    expect(r.model).toBe("mock");
  });

  it("plan task asks a clarifying question when no order ID is present", async () => {
    const r = await model.generate({
      system: `plan\n---CONTEXT---\n${JSON.stringify({ intent: "refund", calledTools: [] })}`,
      messages: [{ role: "user", content: "I want a refund" }],
      task: "plan",
    });
    expect(r.toolCalls).toEqual([]);
    expect(r.content).toMatch(/order number/);
  });

  it("plan task calls orderLookup when an order ID is present", async () => {
    const r = await model.generate({
      system: `plan\n---CONTEXT---\n${JSON.stringify({ intent: "refund", calledTools: [] })}`,
      messages: [{ role: "user", content: "Refund order NW-88412 please" }],
      task: "plan",
    });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].name).toBe("orderLookup");
    expect(r.toolCalls[0].arguments).toEqual({ orderId: "NW-88412" });
  });
});

describe("OpenAICompatibleChatModel (stubbed fetch — no network)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: unknown, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts to {baseUrl}/chat/completions with Bearer auth + model id", async () => {
    const fetchMock = stubFetch({
      choices: [{ message: { content: "hello", tool_calls: [] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const model = new OpenAICompatibleChatModel({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      modelId: "gpt-4o-mini",
    });
    const r = await model.generate({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      task: "draft",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(r.content).toBe("hello");
    expect(r.usage?.totalTokens).toBe(15);
  });

  it("sends tools with parallel_tool_calls=false and parses tool calls", async () => {
    const fetchMock = stubFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                function: {
                  name: "orderLookup",
                  arguments: '{"orderId":"NW-88412"}',
                },
              },
            ],
          },
        },
      ],
    });
    const model = new OpenAICompatibleChatModel({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      modelId: "gpt-4o-mini",
    });
    const r = await model.generate({
      system: "sys",
      messages: [{ role: "user", content: "track NW-88412" }],
      task: "plan",
      tools: [
        {
          name: "orderLookup",
          description: "Look up an order",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toBe("auto");
    expect(r.toolCalls).toEqual([
      { id: "call_1", name: "orderLookup", arguments: { orderId: "NW-88412" } },
    ]);
  });

  it("requests json_object format in jsonMode", async () => {
    const fetchMock = stubFetch({
      choices: [{ message: { content: '{"intent":"refund"}' } }],
    });
    const model = new OpenAICompatibleChatModel({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      modelId: "gpt-4o-mini",
    });
    await model.generate({
      system: "sys",
      messages: [{ role: "user", content: "refund" }],
      task: "route",
      jsonMode: true,
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("throws a clear error on a non-2xx response", async () => {
    stubFetch({ error: { message: "bad key" } }, 401);
    const model = new OpenAICompatibleChatModel({
      baseUrl: "https://api.example.com/v1",
      apiKey: "bad-key",
      modelId: "gpt-4o-mini",
    });
    await expect(
      model.generate({
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        task: "draft",
      }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("getModelConfig", () => {
  it("defaults to api.openai.com + gpt-4o-mini", () => {
    const saved = { ...process.env };
    delete process.env.MODEL_BASE_URL;
    delete process.env.MODEL_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MODEL_ID;
    const config = getModelConfig();
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.modelId).toBe("gpt-4o-mini");
    expect(config.apiKey).toBe("");
    process.env = saved;
  });
});
