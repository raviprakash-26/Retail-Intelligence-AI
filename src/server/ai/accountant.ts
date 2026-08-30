import "server-only";
import { AiAgent, AiRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { statesUnverifiedFigures, systemPrompt } from "@/lib/ai/prompt";
import type { ToolInvocation } from "@/lib/ai/tools";
import {
  completeTurn,
  ProviderError,
  providerStatus,
  type ContentBlock,
  type MessagesClient,
  type ProviderMessage,
  type ReplyOutcome,
} from "@/server/ai/provider";
import { runTool, type ToolContext } from "@/server/ai/tool-runner";

/**
 * The AI Accountant's conversation.
 *
 * The loop is: ask, and if the model wants a figure, run the tool it asked for
 * and hand back exactly what the service returned. Nothing is summarised on the
 * way in and nothing is rounded — the model sees the same numbers the pages
 * show, so an answer that disagrees with a report is a model error rather than
 * a data one, and the transcript proves which.
 *
 * Every turn is persisted with the tool calls that backed it, so a figure in an
 * answer can be traced to the query that produced it months later. The schema
 * asked for exactly that, and it is the reason to trust an answer at all.
 *
 * Two things are computed rather than trusted. An answer stating money with no
 * tool behind it is flagged before anybody reads it. And the tenant is bound
 * from the session into the tool context — the model never names a business.
 */

/** How many times the model may ask for tools before the turn is cut off. */
const MAX_TOOL_ROUNDS = 5;

export type StoredMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  toolCalls: ToolInvocation[];
  /** True where the reply quoted money without asking for any. */
  unverified: boolean;
  errorMessage: string | null;
  createdAt: string;
};

export type Conversation = {
  id: string;
  title: string | null;
  messages: StoredMessage[];
};

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/**
 * Says so when an answer stopped early.
 *
 * The failure this exists to prevent: a reply cut off at the token limit
 * arrives looking exactly like a finished one, and half an answer about
 * somebody's tax position read as the whole of one is worse than no answer.
 * Nothing is invented to fill the gap — the reader is told where it ends.
 */
function truncationAware(text: string, outcome: ReplyOutcome): string {
  if (outcome !== "truncated") return text;
  const note =
    "\n\n_This answer was cut short at its length limit, so it is incomplete. Ask a narrower question to see the rest._";
  return text.length > 0
    ? `${text}${note}`
    : "The assistant ran out of room before it wrote anything. Try a narrower question.";
}

function toStored(row: {
  id: string;
  role: AiRole;
  content: string;
  toolCalls: unknown;
  errorMessage: string | null;
  createdAt: Date;
}): StoredMessage {
  const toolCalls = Array.isArray(row.toolCalls)
    ? (row.toolCalls as ToolInvocation[])
    : [];
  return {
    id: row.id,
    role: row.role === AiRole.USER ? "USER" : "ASSISTANT",
    content: row.content,
    toolCalls,
    unverified:
      row.role === AiRole.ASSISTANT &&
      // The results themselves, not how many there were. A turn that fetched
      // revenue and expenses and then stated a profit called two tools and
      // produced a figure neither of them returned.
      statesUnverifiedFigures(
        row.content,
        toolCalls.map((call) => call.result),
      ),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The conversation to continue, or nothing.
 *
 * Scoped by company *and* user: a conversation id from somebody else's session
 * resolves to nothing rather than to their transcript, which may quote figures
 * their role is not allowed to see.
 */
export async function resolveConversation(params: {
  companyId: string;
  userId: string;
  conversationId?: string | null;
}): Promise<Conversation | null> {
  if (!params.conversationId) return null;

  const row = await prisma.aiConversation.findFirst({
    where: {
      id: params.conversationId,
      companyId: params.companyId,
      userId: params.userId,
      agent: AiAgent.ACCOUNTANT,
    },
    select: {
      id: true,
      title: true,
      messages: {
        where: { role: { in: [AiRole.USER, AiRole.ASSISTANT] } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          content: true,
          toolCalls: true,
          errorMessage: true,
          createdAt: true,
        },
      },
    },
  });

  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    messages: row.messages.map(toStored),
  };
}

export async function listConversations(params: {
  companyId: string;
  userId: string;
  limit?: number;
}): Promise<Array<{ id: string; title: string | null; updatedAt: string }>> {
  const rows = await prisma.aiConversation.findMany({
    where: {
      companyId: params.companyId,
      userId: params.userId,
      agent: AiAgent.ACCOUNTANT,
      isArchived: false,
    },
    orderBy: { updatedAt: "desc" },
    take: params.limit ?? 12,
    select: { id: true, title: true, updatedAt: true },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export type AskResult =
  | { ok: true; conversationId: string }
  | { ok: false; error: string; conversationId?: string };

export async function askAccountant(params: {
  companyId: string;
  userId: string;
  question: string;
  conversationId?: string | null;
  context: ToolContext;
  business: {
    name: string;
    currency: string;
    fiscalYearLabel: string | null;
    fiscalYearFrom: string | null;
    fiscalYearTo: string | null;
    /**
     * The business's own calendar day.
     *
     * Told to the model rather than left to it, and worked out from the shop's
     * time zone rather than UTC — a model asked about "this month" on the first
     * of the month would otherwise be told it is still the last day of the one
     * before, and answer for the wrong month.
     */
    today: string;
  };
  /**
   * Defaulted in production; supplied by the tests.
   *
   * The loop is the part that decides what a tenant actually reads — which
   * replies become answers, which become warnings, and what a refusal turns
   * into — so it is worth driving against canned replies and a real database
   * rather than only in the state where no provider is configured.
   */
  client?: MessagesClient;
}): Promise<AskResult> {
  const status = providerStatus();
  if (!status.available) return { ok: false, error: status.reason };

  const question = params.question.trim();
  if (!question) return { ok: false, error: "Ask a question first." };

  const existing = await resolveConversation({
    companyId: params.companyId,
    userId: params.userId,
    conversationId: params.conversationId,
  });

  const conversation =
    existing ??
    (await prisma.aiConversation.create({
      data: {
        companyId: params.companyId,
        userId: params.userId,
        agent: AiAgent.ACCOUNTANT,
        // The first question, trimmed, is a better title than anything a
        // second model call would invent — and costs nothing.
        title: question.slice(0, 80),
      },
      select: { id: true, title: true },
    }));

  await prisma.aiMessage.create({
    data: {
      companyId: params.companyId,
      conversationId: conversation.id,
      role: AiRole.USER,
      content: question,
    },
  });

  // The provider sees only this conversation, and this conversation belongs to
  // one company. Nothing from another tenant can enter here.
  const history: ProviderMessage[] = [
    ...(existing?.messages ?? [])
      .filter((message) => message.content.trim().length > 0)
      .map((message) => ({
        role:
          message.role === "USER" ? ("user" as const) : ("assistant" as const),
        content: [{ type: "text" as const, text: message.content }],
      })),
    { role: "user", content: [{ type: "text", text: question }] },
  ];

  const system = systemPrompt({
    businessName: params.business.name,
    today: params.business.today,
    fiscalYearLabel: params.business.fiscalYearLabel,
    fiscalYearFrom: params.business.fiscalYearFrom,
    fiscalYearTo: params.business.fiscalYearTo,
    currency: params.business.currency,
  });

  const invocations: ToolInvocation[] = [];
  const startedAt = Date.now();
  let promptTokens: number | null = null;
  let outputTokens: number | null = null;
  let answer = "";

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const reply = await completeTurn({
        system,
        messages: history,
        client: params.client,
      });
      promptTokens = reply.promptTokens;
      outputTokens = reply.outputTokens;

      const toolUses = reply.content.filter(
        (
          block,
        ): block is {
          type: "tool_use";
          id: string;
          name: string;
          input: unknown;
        } => block.type === "tool_use",
      );

      // A refusal is the provider's classifiers declining, not an answer.
      // Whatever sits in `content` past one is empty or partial, and showing
      // either as an answer about somebody's books would be inventing one.
      if (reply.outcome === "refused") {
        answer =
          "The assistant declined to answer that one. Rephrasing it, or asking about the figures directly, usually works.";
        break;
      }

      if (toolUses.length === 0) {
        answer = truncationAware(textOf(reply.content), reply.outcome);
        break;
      }

      // A turn cut off at the token limit stops here rather than looping. The
      // tool calls in a truncated reply can themselves be half-written, and
      // running a partial request against somebody's ledger to produce an
      // answer that was already going to be incomplete helps nobody.
      if (reply.outcome === "truncated") {
        answer = truncationAware(textOf(reply.content), reply.outcome);
        break;
      }

      history.push({ role: "assistant", content: reply.content });

      const results: ContentBlock[] = [];
      for (const use of toolUses) {
        const calledAt = Date.now();
        const outcome = await runTool({
          name: use.name,
          input: use.input,
          context: params.context,
        });
        const latencyMs = Date.now() - calledAt;

        invocations.push(
          outcome.ok
            ? {
                name: use.name,
                input: use.input,
                ok: true,
                result: outcome.result,
                latencyMs,
              }
            : {
                name: use.name,
                input: use.input,
                ok: false,
                error: outcome.error,
                latencyMs,
              },
        );

        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          // Exactly what the service returned. Summarising it here would put a
          // second, quieter calculation between the books and the answer.
          content: JSON.stringify(outcome.ok ? outcome.result : outcome.error),
          is_error: !outcome.ok,
        });
      }

      history.push({ role: "user", content: results });

      if (round === MAX_TOOL_ROUNDS) {
        answer =
          "I asked for more figures than one answer should need and stopped rather than keep going. Try a narrower question.";
      }
    }
  } catch (error) {
    const message =
      error instanceof ProviderError
        ? error.message
        : "The assistant could not be reached.";

    // Recorded rather than swallowed: a turn that failed is part of the
    // transcript, and the tools it did manage to run are part of the record.
    await prisma.aiMessage.create({
      data: {
        companyId: params.companyId,
        conversationId: conversation.id,
        role: AiRole.ASSISTANT,
        content: "",
        toolCalls:
          invocations.length > 0
            ? JSON.parse(JSON.stringify(invocations))
            : undefined,
        errorMessage: message,
        latencyMs: Date.now() - startedAt,
      },
    });
    return { ok: false, error: message, conversationId: conversation.id };
  }

  await prisma.aiMessage.create({
    data: {
      companyId: params.companyId,
      conversationId: conversation.id,
      role: AiRole.ASSISTANT,
      content: answer,
      // Serialised through JSON so Decimals and Dates in tool results land as
      // the strings the transcript should keep.
      toolCalls:
        invocations.length > 0
          ? JSON.parse(JSON.stringify(invocations))
          : undefined,
      model: status.model,
      promptTokens,
      outputTokens,
      latencyMs: Date.now() - startedAt,
    },
  });

  await prisma.aiConversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });

  return { ok: true, conversationId: conversation.id };
}
