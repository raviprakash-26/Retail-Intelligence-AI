import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The assistant's loop, driven against canned replies and a real database.
 *
 * The sibling suite covers the state a fresh installation is in — no provider,
 * nothing faked. This one covers the state a paying one is in, which is where
 * the decisions that matter actually live: which replies become answers, which
 * become warnings, what a refusal turns into, and what is written to the
 * transcript in each case.
 *
 * The model is still not exercised. A suite that called a real provider would
 * be testing the weather; what is tested here is this application's reading of
 * a reply, which is deterministic and is the part that can be wrong.
 */

// Before the imports evaluate: `env` parses on first access, and the assistant
// must be switched on for this file. `.env.test` disables it for every other.
vi.hoisted(() => {
  process.env.AI_DRIVER = "anthropic";
  process.env.AI_API_KEY = "sk-ant-test-key-not-a-real-one";
  process.env.AI_MODEL = "claude-sonnet-5";
});

// Types are erased, so a static type import does not evaluate the module and
// cannot beat the hoisted environment above.
import type { RegisterInput } from "@/lib/validation/auth";
import type { MessagesClient } from "@/server/ai/provider";

const { askAccountant, resolveConversation } =
  await import("@/server/ai/accountant");
const { providerStatus } = await import("@/server/ai/provider");
const {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  uniqueSlug,
} = await import("../helpers/test-db");
const { registerOwner } = await import("@/server/auth/registration");

type Fixture = { companyId: string; userId: string };

const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function registrationInput(email: string): RegisterInput {
  return {
    account: {
      fullName: "Ravi Prakash",
      email,
      mobile: "9845012345",
      password: "MountainRiver42!",
      confirmPassword: "MountainRiver42!",
      acceptTerms: true,
    },
    business: {
      businessName: `Loop ${uniqueSlug("Mart")}`,
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: "29AAAPR1234K1ZP",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 0,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

async function createCompany(): Promise<Fixture> {
  const email = `loop-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return { companyId: result.companyId, userId: result.userId };
}

/** A client that answers each turn from a queue, in order. */
function scriptedClient(replies: unknown[]): MessagesClient {
  let turn = 0;
  return {
    messages: {
      create: async () => {
        const reply = replies[turn];
        turn += 1;
        if (reply === undefined) {
          throw new Error(
            `the loop asked for turn ${turn}, which is unscripted`,
          );
        }
        return reply as never;
      },
    },
  } as unknown as MessagesClient;
}

function textReply(text: string, over: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
    ...over,
  };
}

async function ask(fixture: Fixture, question: string, client: MessagesClient) {
  return askAccountant({
    companyId: fixture.companyId,
    userId: fixture.userId,
    question,
    client,
    context: {
      companyId: fixture.companyId,
      fiscalYearStart: null,
      fiscalYearEnd: null,
    },
    business: {
      name: "Loop Mart",
      currency: "INR",
      fiscalYearLabel: null,
      fiscalYearFrom: null,
      fiscalYearTo: null,
      today: "2026-08-30",
    },
  });
}

async function transcript(fixture: Fixture, id: string) {
  const conversation = await resolveConversation({
    companyId: fixture.companyId,
    userId: fixture.userId,
    conversationId: id,
  });
  return conversation?.messages ?? [];
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const companyId of createdCompanies) {
    await purgeTestCompany(companyId).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("with a provider configured", () => {
  it("is switched on, which is what the rest of this file assumes", () => {
    expect(providerStatus().available).toBe(true);
  });

  it("stores a finished answer as the answer", async () => {
    const fixture = await createCompany();
    const result = await ask(
      fixture,
      "What is my closing balance?",
      scriptedClient([textReply("Your closing cash balance is nil.")]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const messages = await transcript(fixture, result.conversationId);
    expect(messages[1]?.content).toBe("Your closing cash balance is nil.");
    expect(messages[1]?.errorMessage).toBeNull();
  });

  it("says an answer was cut short rather than presenting half of one", async () => {
    // The whole reason `truncated` exists. Half an answer about somebody's tax
    // position, read as the whole of one, is worse than no answer — so the
    // reader is told where it stops, and nothing is invented to fill the gap.
    const fixture = await createCompany();
    const result = await ask(
      fixture,
      "Explain my GST position in full",
      scriptedClient([
        textReply("Your output tax for the quarter is ₹42,000 and your input", {
          stop_reason: "max_tokens",
        }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const answer = (await transcript(fixture, result.conversationId))[1]
      ?.content;
    expect(answer).toContain("₹42,000");
    expect(answer).toMatch(/cut short|incomplete/i);
  });

  it("does not present a refusal as an answer about the books", async () => {
    const fixture = await createCompany();
    const result = await ask(
      fixture,
      "Something the classifiers decline",
      scriptedClient([textReply("", { stop_reason: "refusal", content: [] })]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const answer = (await transcript(fixture, result.conversationId))[1]
      ?.content;
    expect(answer).toMatch(/declined/i);
  });

  it("runs the tool the model asks for and answers from what it returned", async () => {
    const fixture = await createCompany();
    const result = await ask(
      fixture,
      "What is my trial balance?",
      scriptedClient([
        {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "trial_balance",
              input: {},
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        textReply("Every account is at nil, so the books balance at zero."),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const messages = await transcript(fixture, result.conversationId);
    // The tool call is part of the record, which is the whole reason to trust
    // the figure in the answer above it.
    expect(messages[1]?.toolCalls[0]?.name).toBe("trial_balance");
    expect(messages[1]?.content).toMatch(/balance at zero/i);
  });

  it("stops on a truncated turn rather than running half-written tool calls", async () => {
    // A reply cut off at the limit can carry a tool call that was still being
    // written. Running it against somebody's ledger, to produce an answer that
    // was already going to be incomplete, helps nobody — so the loop stops and
    // the second scripted reply is never requested.
    const fixture = await createCompany();
    const result = await ask(
      fixture,
      "A question that runs long",
      scriptedClient([
        {
          content: [
            { type: "text", text: "Let me check that." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "trial_balance",
              input: {},
            },
          ],
          stop_reason: "max_tokens",
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        // If the loop continued it would take this and the assertion below
        // would fail — which is the point.
        textReply("A second turn that should never happen."),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const messages = await transcript(fixture, result.conversationId);
    expect(messages[1]?.content).not.toContain("should never happen");
    expect(messages[1]?.content).toMatch(/cut short|incomplete/i);
  });

  it("records a provider failure without repeating what the provider said", async () => {
    // The failing path writes to the transcript, so whatever it writes is
    // persisted and readable by the tenant. The provider's own text — which on
    // a bad request is the whole serialised error body — is not what lands.
    const anthropic = await import("@anthropic-ai/sdk");
    const fixture = await createCompany();

    const failing = {
      messages: {
        create: async () => {
          throw anthropic.default.APIError.generate(
            400,
            { error: { message: "x-api-key sk-ant-leaked-credential" } },
            "bad request",
            new Headers(),
          );
        },
      },
    } as unknown as MessagesClient;

    const result = await ask(fixture, "Anything", failing);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain("sk-ant-leaked-credential");

    const messages = await transcript(fixture, result.conversationId ?? "");
    expect(messages[1]?.errorMessage ?? "").not.toContain("sk-ant");
  });
});
