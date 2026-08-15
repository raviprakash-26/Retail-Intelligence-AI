import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";
import { toolSchemas } from "@/lib/ai/tools";

/**
 * Talking to the model provider.
 *
 * **The key never leaves this module.** It is read from the validated
 * server-side environment, handed to the client once, and never returned,
 * logged or included in anything that reaches a component. Nothing the browser
 * receives from the assistant contains a credential.
 *
 * **When no provider is configured, nothing is faked.** The assistant is not
 * quietly replaced by canned answers or by a rules engine pretending to be one:
 * the page says it has not been set up, and the composer is disabled. A
 * financial assistant that invents plausible replies when its provider is
 * missing is worse than one that is honestly switched off.
 *
 * This was a hand-rolled `fetch` against the REST endpoint. Moving to the
 * official SDK is not cosmetic: the hand-rolled version retried nothing (a
 * single 429 on a busy afternoon surfaced as "the assistant could not be
 * reached"), had one error class for every failure, could not tell a refusal or
 * a cut-off answer from a finished one, and forwarded the provider's own error
 * text to the reader.
 */

export type ProviderStatus =
  { available: true; model: string } | { available: false; reason: string };

export function providerStatus(): ProviderStatus {
  if (env.AI_DRIVER === "disabled") {
    return {
      available: false,
      reason:
        "The assistant has not been set up on this installation. Ask whoever runs it to configure an AI provider.",
    };
  }
  if (env.AI_DRIVER === "openai") {
    // The environment schema allows it; this module has not been written for
    // it. Saying so is better than pretending the driver works.
    return {
      available: false,
      reason:
        "This installation is configured for OpenAI, which the assistant does not talk to yet.",
    };
  }
  if (!env.AI_API_KEY) {
    // Unreachable through the environment validator, which refuses to start a
    // server configured for a provider with no key. Kept as the second half of
    // that guarantee rather than as a live branch: this module must not fall
    // back to an empty key if that rule is ever relaxed.
    return {
      available: false,
      reason: "The assistant is configured but has no API key.",
    };
  }
  return { available: true, model: env.AI_MODEL };
}

/** A block in a message, in the shape this application works in. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export type ProviderMessage = {
  role: "user" | "assistant";
  content: ContentBlock[];
};

/**
 * Why the model stopped, in terms this application cares about.
 *
 * `truncated` and `refused` exist because both were previously invisible. A
 * reply cut off at the token limit arrived looking exactly like a finished
 * one — which, for an answer about somebody's tax position, is the worst
 * available failure: it reads as complete and is missing the second half.
 */
export type ReplyOutcome = "complete" | "tool_use" | "truncated" | "refused";

export type ProviderReply = {
  content: ContentBlock[];
  outcome: ReplyOutcome;
  stopReason: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  /** Tokens served from cache. Zero every turn means caching is not working. */
  cacheReadTokens: number | null;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when trying the same request again might work. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** How long to wait before giving up on a turn. */
const TIMEOUT_MS = 60_000;

/**
 * Two retries, on top of the SDK's own backoff.
 *
 * The SDK retries 429 and 5xx. Anything it gives up on is a real outage rather
 * than a blip, and a shopkeeper waiting on an answer would rather be told to
 * try again than watch a spinner.
 */
const MAX_RETRIES = 2;

/**
 * The slice of the SDK this module actually uses.
 *
 * Narrow on purpose: it is the seam the tests supply a stub through, in the
 * same shape as the payment provider's injectable transport, and for the same
 * reason. Everything worth proving about this module — that a truncated reply
 * is not read as a finished one, that the key never reaches the request body,
 * that a rate limit becomes advice rather than an error page — is provable
 * against a canned response. What is *not* proven is the round trip to
 * Anthropic, and the README says so rather than implying otherwise.
 */
export type MessagesClient = {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
};

let shared: Anthropic | null = null;

function sharedClient(apiKey: string): MessagesClient {
  // One client, reused. It holds a connection pool; building a new one per
  // question would open a new pool per question.
  shared ??= new Anthropic({
    apiKey,
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
  return shared;
}

function outcomeFor(stopReason: string | null): ReplyOutcome {
  switch (stopReason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "truncated";
    case "refusal":
      return "refused";
    default:
      return "complete";
  }
}

/**
 * One turn.
 *
 * The system prompt carries a cache breakpoint. Tools render before system, so
 * a breakpoint on the system block caches the tool schemas with it — and those
 * are identical on every turn of every conversation. Without it, a nine-tool
 * schema list and a long instruction block were re-read at full price on every
 * question, including each round of a multi-tool answer.
 *
 * What is deliberately *not* sent: `temperature` and `top_p`. Both are rejected
 * by the models this product runs, and neither was doing anything a clearer
 * instruction could not.
 */
export async function completeTurn(params: {
  system: string;
  messages: ProviderMessage[];
  /** Defaulted in production; supplied by the tests. */
  client?: MessagesClient;
}): Promise<ProviderReply> {
  const status = providerStatus();
  if (!status.available) throw new ProviderError(status.reason);

  const client = params.client ?? sharedClient(env.AI_API_KEY ?? "");

  try {
    const response = await client.messages.create({
      model: status.model,
      // Covers thinking *and* the answer. Thinking is on by default on the
      // current models, so a limit sized for the answer alone truncates.
      max_tokens: env.AI_MAX_OUTPUT_TOKENS,
      // Reading a ledger and explaining it is not a reasoning-heavy task, and
      // this is a per-question cost a small shop pays. Adaptive thinking at low
      // effort keeps the arithmetic checks without paying for deliberation the
      // question does not need.
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: [
        {
          type: "text",
          text: params.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: params.messages as Anthropic.MessageParam[],
      tools: toolSchemas() as Anthropic.Tool[],
    });

    return {
      content: response.content as ContentBlock[],
      outcome: outcomeFor(response.stop_reason),
      stopReason: response.stop_reason,
      promptTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
    };
  } catch (error) {
    throw describeProviderFailure(error);
  }
}

/**
 * The provider's failure, in words a shopkeeper can act on.
 *
 * Typed classes rather than string matching on the message. **The provider's
 * own text is never forwarded** — it is replaced.
 *
 * That is not tidiness. The message on a `ProviderError` is written to
 * `aiMessage.errorMessage` and shown in the tenant's transcript, so whatever
 * this function returns is persisted and readable. The SDK builds its message
 * by serialising the whole error body, and a provider that echoed the offending
 * request into that body — headers included — would put a credential in a
 * customer's database. Mapping status to our own sentence closes that path by
 * construction rather than by sanitising after the fact, and the raw text was
 * never something a shopkeeper could act on anyway.
 */
function describeProviderFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  // The detail goes here, where an operator can read it and a tenant cannot.
  // The provider's message is deliberately *not* included even in the log: it
  // is an unstructured string, so there is no key for the logger's redaction to
  // work on. The status, class and request id are enough to find the request in
  // the provider's own dashboard, which shows the body in full.
  if (error instanceof Anthropic.APIError) {
    logger.error("The AI provider returned an error.", {
      errorClass: error.constructor.name,
      status: error.status ?? null,
      requestId: error.requestID ?? null,
    });
  }

  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError(
      "The assistant is being asked more questions than its plan allows right now. Try again in a minute.",
      429,
      true,
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    // Deliberately vague to the reader, specific to the operator: a shopkeeper
    // cannot fix this and should not be shown a key-shaped hint.
    return new ProviderError(
      "The assistant's provider rejected this installation's credentials. Whoever runs it needs to check the API key.",
      401,
    );
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError(
      "The assistant took too long to answer. Try again.",
      undefined,
      true,
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError(
      "The assistant could not be reached.",
      undefined,
      true,
    );
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? undefined;
    const retryable = status !== undefined && status >= 500;
    return new ProviderError(
      retryable
        ? "The assistant's provider is having trouble. Try again in a minute."
        : "The assistant could not answer that. Whoever runs this installation can see why in the server log.",
      status,
      retryable,
    );
  }

  return new ProviderError(
    "The assistant could not be reached.",
    undefined,
    true,
  );
}
