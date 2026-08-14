import "server-only";
import { env } from "@/lib/env";
import { toolSchemas } from "@/lib/ai/tools";

/**
 * Talking to the model provider.
 *
 * **The key never leaves this module.** It is read from the validated
 * server-side environment, used in a header, and never returned, logged or
 * included in anything that reaches a component. Nothing the browser receives
 * from the assistant contains a credential.
 *
 * **When no provider is configured, nothing is faked.** The assistant is not
 * quietly replaced by canned answers or by a rules engine pretending to be one:
 * the page says it has not been set up, and the composer is disabled. A
 * financial assistant that invents plausible replies when its provider is
 * missing is worse than one that is honestly switched off.
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
    return {
      available: false,
      reason: "The assistant is configured but has no API key.",
    };
  }
  return { available: true, model: env.AI_MODEL };
}

/** A block in a message, in the shape the provider expects and returns. */
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

export type ProviderReply = {
  content: ContentBlock[];
  stopReason: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** How long to wait before giving up on a turn. */
const TIMEOUT_MS = 60_000;

type AnthropicResponse = {
  content?: ContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

export async function completeTurn(params: {
  system: string;
  messages: ProviderMessage[];
}): Promise<ProviderReply> {
  const status = providerStatus();
  if (!status.available) throw new ProviderError(status.reason);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        // Read here and nowhere else. It is never put into a response body, an
        // error message, or anything a component can see.
        "x-api-key": env.AI_API_KEY ?? "",
      },
      body: JSON.stringify({
        model: status.model,
        max_tokens: env.AI_MAX_OUTPUT_TOKENS,
        system: params.system,
        messages: params.messages,
        tools: toolSchemas(),
      }),
    });

    const payload = (await response.json()) as AnthropicResponse;

    if (!response.ok) {
      // The provider's message, never the request — which carries the key.
      throw new ProviderError(
        payload.error?.message ??
          `The assistant's provider returned ${response.status}.`,
        response.status,
      );
    }

    return {
      content: payload.content ?? [],
      stopReason: payload.stop_reason ?? null,
      promptTokens: payload.usage?.input_tokens ?? null,
      outputTokens: payload.usage?.output_tokens ?? null,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("The assistant took too long to answer.");
    }
    throw new ProviderError(
      error instanceof Error
        ? `The assistant could not be reached: ${error.message}`
        : "The assistant could not be reached.",
    );
  } finally {
    clearTimeout(timeout);
  }
}
