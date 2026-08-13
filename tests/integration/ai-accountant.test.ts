import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiAgent, AiRole } from "@prisma/client";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import {
  askAccountant,
  listConversations,
  resolveConversation,
} from "@/server/ai/accountant";
import { providerStatus } from "@/server/ai/provider";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The assistant's conversation.
 *
 * The model itself is not exercised here — there is no provider configured in
 * a test run, and a suite that depended on one would be testing the weather.
 * What is exercised is everything around it: that a missing provider produces
 * an honest refusal rather than a substitute, that a transcript belongs to one
 * user of one company and resolves to nothing for anybody else, and that an
 * answer quoting money with no query behind it comes back marked.
 */

const prisma = testDb();
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
      businessName: `Chat ${uniqueSlug("Mart")}`,
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

type Fixture = { companyId: string; userId: string };

async function createCompany(): Promise<Fixture> {
  const email = `chat-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return { companyId: result.companyId, userId: result.userId };
}

/** A transcript written straight in, so the reading side can be tested alone. */
async function seedConversation(
  fixture: Fixture,
  messages: Array<{ role: AiRole; content: string; toolCalls?: unknown }>,
): Promise<string> {
  const conversation = await prisma.aiConversation.create({
    data: {
      companyId: fixture.companyId,
      userId: fixture.userId,
      agent: AiAgent.ACCOUNTANT,
      title: "Seeded",
    },
    select: { id: true },
  });

  for (const message of messages) {
    await prisma.aiMessage.create({
      data: {
        companyId: fixture.companyId,
        conversationId: conversation.id,
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls as never,
      },
    });
  }

  return conversation.id;
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

describe("with no provider configured", () => {
  it("says so rather than substituting an answer", async () => {
    // The test environment has no AI driver, which is exactly the state a
    // fresh installation is in. Nothing is faked in that state.
    const status = providerStatus();
    expect(status.available).toBe(false);

    const fixture = await createCompany();
    const result = await askAccountant({
      companyId: fixture.companyId,
      userId: fixture.userId,
      question: "How much did I make this year?",
      context: {
        companyId: fixture.companyId,
        fiscalYearStart: null,
        fiscalYearEnd: null,
      },
      business: {
        name: "Chat Mart",
        currency: "INR",
        fiscalYearLabel: null,
        fiscalYearFrom: null,
        fiscalYearTo: null,
      },
    });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/has not been set up/i);
  });

  it("writes nothing to the transcript when it cannot answer at all", async () => {
    const fixture = await createCompany();
    await askAccountant({
      companyId: fixture.companyId,
      userId: fixture.userId,
      question: "Anything at all",
      context: {
        companyId: fixture.companyId,
        fiscalYearStart: null,
        fiscalYearEnd: null,
      },
      business: {
        name: "Chat Mart",
        currency: "INR",
        fiscalYearLabel: null,
        fiscalYearFrom: null,
        fiscalYearTo: null,
      },
    });

    const count = await prisma.aiConversation.count({
      where: { companyId: fixture.companyId },
    });
    expect(count).toBe(0);
  });
});

describe("a transcript belongs to one user of one company", () => {
  it("resolves for the user who owns it", async () => {
    const fixture = await createCompany();
    const id = await seedConversation(fixture, [
      { role: AiRole.USER, content: "Who owes me money?" },
      { role: AiRole.ASSISTANT, content: "Two customers do." },
    ]);

    const conversation = await resolveConversation({
      companyId: fixture.companyId,
      userId: fixture.userId,
      conversationId: id,
    });

    expect(conversation?.messages).toHaveLength(2);
    expect(conversation?.messages[0]?.role).toBe("USER");
  });

  it("resolves to nothing for another user of the same company", async () => {
    // A transcript can quote figures a colleague's role is not allowed to see.
    const fixture = await createCompany();
    const other = await createCompany();
    const id = await seedConversation(fixture, [
      { role: AiRole.USER, content: "What is my margin?" },
    ]);

    const conversation = await resolveConversation({
      companyId: fixture.companyId,
      userId: other.userId,
      conversationId: id,
    });
    expect(conversation).toBeNull();
  });

  it("resolves to nothing for another company", async () => {
    const mine = await createCompany();
    const theirs = await createCompany();
    const id = await seedConversation(theirs, [
      { role: AiRole.USER, content: "What did we take last week?" },
    ]);

    const conversation = await resolveConversation({
      companyId: mine.companyId,
      userId: mine.userId,
      conversationId: id,
    });
    expect(conversation).toBeNull();
  });

  it("lists only this user's conversations", async () => {
    const mine = await createCompany();
    const theirs = await createCompany();
    await seedConversation(mine, [{ role: AiRole.USER, content: "Mine" }]);
    await seedConversation(theirs, [{ role: AiRole.USER, content: "Theirs" }]);

    const listed = await listConversations({
      companyId: mine.companyId,
      userId: mine.userId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("Seeded");
  });

  it("returns nothing when no conversation was asked for", async () => {
    const fixture = await createCompany();
    const conversation = await resolveConversation({
      companyId: fixture.companyId,
      userId: fixture.userId,
      conversationId: null,
    });
    expect(conversation).toBeNull();
  });
});

describe("marking an answer nothing was looked up for", () => {
  it("flags a reply that quotes money with no query behind it", async () => {
    const fixture = await createCompany();
    const id = await seedConversation(fixture, [
      { role: AiRole.USER, content: "How much did I make?" },
      { role: AiRole.ASSISTANT, content: "You made about ₹4,20,000." },
    ]);

    const conversation = await resolveConversation({
      companyId: fixture.companyId,
      userId: fixture.userId,
      conversationId: id,
    });

    const answer = conversation?.messages[1];
    expect(answer?.unverified).toBe(true);
    expect(answer?.toolCalls).toHaveLength(0);
  });

  it("does not flag the same reply when a query backed it", async () => {
    const fixture = await createCompany();
    const id = await seedConversation(fixture, [
      { role: AiRole.USER, content: "How much did I make?" },
      {
        role: AiRole.ASSISTANT,
        content: "You made ₹4,20,000.",
        toolCalls: [
          {
            name: "financial_statements",
            input: { from: "2026-04-01", to: "2027-03-31" },
            ok: true,
            result: { trading: { revenueTotal: "420000.0000" } },
            latencyMs: 12,
          },
        ],
      },
    ]);

    const conversation = await resolveConversation({
      companyId: fixture.companyId,
      userId: fixture.userId,
      conversationId: id,
    });

    const answer = conversation?.messages[1];
    expect(answer?.unverified).toBe(false);
    expect(answer?.toolCalls[0]?.name).toBe("financial_statements");
  });

  it("never flags what the user themselves typed", async () => {
    const fixture = await createCompany();
    const id = await seedConversation(fixture, [
      {
        role: AiRole.USER,
        content: "I think I made ₹5,00,000 — is that right?",
      },
    ]);

    const conversation = await resolveConversation({
      companyId: fixture.companyId,
      userId: fixture.userId,
      conversationId: id,
    });
    expect(conversation?.messages[0]?.unverified).toBe(false);
  });

  it("keeps the queries behind an answer so a figure stays traceable", async () => {
    // Months later, "where did that number come from" has an answer.
    const fixture = await createCompany();
    const id = await seedConversation(fixture, [
      { role: AiRole.USER, content: "GST for June?" },
      {
        role: AiRole.ASSISTANT,
        content: "₹1,800 would be payable, prepared for review.",
        toolCalls: [
          {
            name: "gst_working_paper",
            input: { year: 2026, month: 6 },
            ok: true,
            result: { setOff: { totalPayable: "1800.0000" } },
            latencyMs: 30,
          },
        ],
      },
    ]);

    const conversation = await resolveConversation({
      companyId: fixture.companyId,
      userId: fixture.userId,
      conversationId: id,
    });

    const call = conversation?.messages[1]?.toolCalls[0];
    expect(call?.input).toEqual({ year: 2026, month: 6 });
    expect(call?.ok).toBe(true);
  });
});
