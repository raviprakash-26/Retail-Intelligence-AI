import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ProviderModule from "@/server/ai/provider";
import type { MessagesClient } from "@/server/ai/provider";

/**
 * The provider seam.
 *
 * `env` parses once at import, so each case sets the environment and then
 * imports the module — the same pattern the metrics endpoint tests use.
 *
 * What is worth testing here is not that the SDK works. It is what this
 * application decides on top of it: that a missing provider is refused rather
 * than faked, that a reply cut off at the token limit is not reported as a
 * finished answer, that a refusal is not read as content, and that nothing the
 * provider says about a failure is repeated to a tenant.
 */

const TOKEN = "sk-ant-test-key-not-a-real-one";

async function loadProvider(
  env: Record<string, string | undefined> = {},
): Promise<typeof ProviderModule> {
  vi.resetModules();
  process.env.AI_DRIVER = env.AI_DRIVER ?? "anthropic";
  process.env.AI_API_KEY = env.AI_API_KEY ?? TOKEN;
  process.env.AI_MODEL = env.AI_MODEL ?? "claude-sonnet-5";
  if (env.AI_MAX_OUTPUT_TOKENS !== undefined) {
    process.env.AI_MAX_OUTPUT_TOKENS = env.AI_MAX_OUTPUT_TOKENS;
  }
  return import("@/server/ai/provider");
}

afterEach(() => {
  delete process.env.AI_DRIVER;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.AI_MAX_OUTPUT_TOKENS;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("whether the assistant is switched on", () => {
  it("is unavailable, with a reason, when no driver is configured", async () => {
    const { providerStatus } = await loadProvider({ AI_DRIVER: "disabled" });
    const status = providerStatus();

    expect(status.available).toBe(false);
    if (!status.available) {
      expect(status.reason).toMatch(/has not been set up/i);
    }
  });

  it("refuses the whole configuration when a provider has no key", async () => {
    // Stronger than reporting it as a status: the environment validator rejects
    // the configuration outright, so there is no window in which the assistant
    // is switched on and holding an empty credential. The provider module's own
    // no-key branch is the second half of that guarantee and is unreachable
    // while this rule holds — which is what this asserts.
    const { providerStatus } = await loadProvider({ AI_API_KEY: "" });
    expect(() => providerStatus()).toThrow(/AI_API_KEY is required/i);
  });

  it("says so plainly for a driver this build does not talk to", async () => {
    // Better than a button that resolves against nothing.
    const { providerStatus } = await loadProvider({ AI_DRIVER: "openai" });
    const status = providerStatus();
    expect(status.available).toBe(false);
    if (!status.available) expect(status.reason).toMatch(/OpenAI/i);
  });

  it("reports the configured model when it is available", async () => {
    const { providerStatus } = await loadProvider();
    expect(providerStatus()).toEqual({
      available: true,
      model: "claude-sonnet-5",
    });
  });

  it("refuses to call the provider at all when unavailable", async () => {
    // The guard sits in front of the request, so a misconfigured install cannot
    // spend money discovering it is misconfigured.
    const { completeTurn } = await loadProvider({ AI_DRIVER: "disabled" });
    await expect(completeTurn({ system: "s", messages: [] })).rejects.toThrow(
      /has not been set up/i,
    );
  });
});

/** A reply in the shape the SDK returns one. */
function reply(over: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: "Your closing balance is ₹1,04,522." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0 },
    ...over,
  };
}

/**
 * A stub client, in the shape the module asks for.
 *
 * Not a spy on the SDK class: `messages` is built per instance rather than
 * living on the prototype, so there is nothing on the class to intercept. The
 * module takes a client instead — the same seam the payment provider uses for
 * its transport.
 */
function stubClient(answer: () => Promise<unknown>) {
  const create = vi.fn((_body: unknown) => answer());
  return {
    client: { messages: { create } } as unknown as MessagesClient,
    create,
  };
}

async function withStubbedCreate(
  result: unknown,
  env: Record<string, string | undefined> = {},
) {
  const provider = await loadProvider(env);
  const { client, create } = stubClient(() => Promise.resolve(result));
  return { provider, client, create };
}

describe("reading what came back", () => {
  it("reports a finished answer as complete", async () => {
    const { provider, client } = await withStubbedCreate(reply());
    const result = await provider.completeTurn({
      client,
      system: "You are an accountant.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(result.outcome).toBe("complete");
    expect(result.promptTokens).toBe(900);
  });

  it("marks a reply that hit the token limit as truncated", async () => {
    // The failure this exists to catch: a reply cut off mid-sentence arrives
    // looking exactly like a finished one. On an answer about somebody's tax
    // position, half of one read as the whole is the worst available outcome.
    const { provider, client } = await withStubbedCreate(
      reply({ stop_reason: "max_tokens" }),
    );
    const result = await provider.completeTurn({
      client,
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(result.outcome).toBe("truncated");
  });

  it("marks a refusal as refused rather than as an answer", async () => {
    const { provider, client } = await withStubbedCreate(
      reply({ stop_reason: "refusal", content: [] }),
    );
    const result = await provider.completeTurn({
      client,
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(result.outcome).toBe("refused");
  });

  it("recognises a turn that wants a tool", async () => {
    const { provider, client } = await withStubbedCreate(
      reply({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_1", name: "trial_balance", input: {} },
        ],
      }),
    );
    const result = await provider.completeTurn({
      client,
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(result.outcome).toBe("tool_use");
  });
});

describe("what the request carries", () => {
  it("sends no sampling parameters, which the current models reject", async () => {
    // temperature and top_p return a 400 on the models this product runs.
    const { provider, client, create } = await withStubbedCreate(reply());
    await provider.completeTurn({
      client,
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
  });

  it("caches the system prompt, which carries the tool schemas with it", async () => {
    // Tools render before system, so one breakpoint covers both — and both are
    // identical on every turn of every conversation. Without it a nine-tool
    // schema list is re-read at full price on every question.
    const { provider, client, create } = await withStubbedCreate(reply());
    await provider.completeTurn({
      client,
      system: "A long instruction block.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const body = create.mock.calls[0]?.[0] as {
      system: Array<{ cache_control?: unknown }>;
      tools: unknown[];
    };
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.length).toBeGreaterThan(0);
  });

  it("budgets for thinking as well as the answer", async () => {
    // The current models think by default and the cap covers both. A limit
    // sized for the answer alone truncates.
    const { provider, client, create } = await withStubbedCreate(reply());
    await provider.completeTurn({
      client,
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const body = create.mock.calls[0]?.[0] as {
      max_tokens: number;
      thinking?: { type: string };
    };
    expect(body.thinking?.type).toBe("adaptive");
    expect(body.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it("never puts the key anywhere but the client", async () => {
    const { provider, client, create } = await withStubbedCreate(reply());
    await provider.completeTurn({
      client,
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain(TOKEN);
  });
});

describe("when the provider fails", () => {
  /**
   * The error the SDK would raise for a given HTTP response.
   *
   * Built through `APIError.generate`, which is what the SDK itself calls on a
   * real response — so these are the classes production actually receives,
   * rather than my guess at which one a 429 produces.
   */
  async function apiError(status: number, message: string) {
    const anthropic = await import("@anthropic-ai/sdk");
    return anthropic.default.APIError.generate(
      status,
      { error: { message } },
      message,
      new Headers(),
    );
  }

  async function failing(error: unknown) {
    const provider = await loadProvider();
    const { client } = stubClient(() => Promise.reject(error));
    return async () =>
      provider.completeTurn({ client, system: "s", messages: [] });
  }

  it("tells somebody to wait rather than that the assistant is broken", async () => {
    const turn = await failing(await apiError(429, "rate limited"));
    await expect(turn()).rejects.toThrow(/try again in a minute/i);
  });

  it("points a bad key at the operator, not at the shopkeeper", async () => {
    const turn = await failing(await apiError(401, "invalid x-api-key"));

    // A shopkeeper cannot fix a bad key and should not be shown a key-shaped
    // hint. The message names who can, and quotes nothing back.
    await expect(turn()).rejects.toThrow(/whoever runs it/i);
    await expect(turn()).rejects.not.toThrow(/x-api-key/);
  });

  it("marks a timeout retryable and a bad request not", async () => {
    // A timeout is worth another go; a malformed request will fail the same way
    // forever, and telling somebody to retry it wastes their afternoon.
    const anthropic = await import("@anthropic-ai/sdk");

    const timeout = await failing(
      new anthropic.default.APIConnectionTimeoutError({ message: "timed out" }),
    );
    await expect(timeout()).rejects.toMatchObject({ retryable: true });

    const bad = await failing(await apiError(400, "bad request"));
    await expect(bad()).rejects.toMatchObject({ retryable: false });
  });

  it("does not repeat the provider's own error text to a tenant", async () => {
    // This message is persisted to aiMessage.errorMessage and shown in the
    // tenant's transcript. The SDK builds its message by serialising the whole
    // error body, so a provider that echoed the offending request back — an
    // x-api-key header included — would put a credential in a customer's
    // database. Nothing from the body is forwarded.
    const turn = await failing(
      await apiError(400, `invalid request: x-api-key ${TOKEN}`),
    );

    await expect(turn()).rejects.not.toThrow(new RegExp(TOKEN));
    await expect(turn()).rejects.not.toThrow(/invalid request/);
  });
});
