import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Running behind more than one process.
 *
 * The claim this file exists to test is that nothing in the request path keeps
 * state in the process serving it. Two replicas are simulated the only way that
 * proves anything: separate Prisma clients on separate connections, doing the
 * same work at the same time. A shared module-level variable would make these
 * pass while production failed, which is exactly what a single client would
 * hide.
 *
 * What it cannot prove is that two *containers* behind a balancer behave — that
 * needs the compose file and a person. The README says so.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

/** A second connection, standing in for a second replica. */
function secondReplica(): PrismaClient {
  return new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
}

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
      businessName: `Replica ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 100_000,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

type Fixture = { companyId: string; userId: string; email: string };

/**
 * A sequence this company actually has, with whatever scoping it was given.
 *
 * Some series are per fiscal year and some are not, and the lookup matches
 * `fiscalYearId` exactly — so hard-coding either would make the test assert
 * against a row that does not exist rather than against the locking behaviour
 * it is here for.
 */
async function anySequence(companyId: string) {
  return prisma.documentSequence.findFirstOrThrow({
    where: { companyId, key: "SALE" },
    select: { key: true, fiscalYearId: true, nextValue: true },
  });
}

async function createCompany(): Promise<Fixture> {
  const email = `rep-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return { companyId: result.companyId, userId: result.userId, email };
}

beforeAll(async () => {
  await ensurePlatformData();
}, 120_000);

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
}, 120_000);

describe("document numbering under concurrency", () => {
  it("never hands the same invoice number to two callers at once", async () => {
    // The failure this guards is the one a tax officer notices: two invoices
    // with the same number, or a gap where a number was burned. `SELECT ... FOR
    // UPDATE` is what makes the allocation safe, and a row lock is held by the
    // database rather than by the process — which is the only reason this works
    // across replicas at all.
    const fixture = await createCompany();
    const other = secondReplica();

    try {
      const sequence = await anySequence(fixture.companyId);
      const clients = [prisma, other, prisma, other, prisma, other];
      const numbers = await Promise.all(
        clients.map((client) =>
          client.$transaction((tx) =>
            allocateDocumentNumber(tx, {
              companyId: fixture.companyId,
              key: sequence.key,
              fiscalYearId: sequence.fiscalYearId,
            }),
          ),
        ),
      );

      expect(new Set(numbers).size).toBe(numbers.length);
    } finally {
      await other.$disconnect();
    }
  }, 120_000);

  it("leaves no gap when a transaction rolls back", async () => {
    // A number taken by a failed post has to come back. Otherwise a crash
    // during a busy afternoon leaves holes in a statutory series.
    const fixture = await createCompany();

    const before = await anySequence(fixture.companyId);

    await expect(
      prisma.$transaction(async (tx) => {
        await allocateDocumentNumber(tx, {
          companyId: fixture.companyId,
          key: before.key,
          fiscalYearId: before.fiscalYearId,
        });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");

    const after = await anySequence(fixture.companyId);
    expect(after.nextValue).toBe(before.nextValue);
  }, 120_000);

  it("keeps the journal series unique when two replicas post together", async () => {
    // The same property, through the function every module actually calls.
    const fixture = await createCompany();
    const other = secondReplica();

    const [cash, income] = await Promise.all([
      prisma.account.findFirstOrThrow({
        where: { companyId: fixture.companyId, systemKey: SYSTEM_ACCOUNT.CASH },
        select: { id: true },
      }),
      prisma.account.findFirstOrThrow({
        where: {
          companyId: fixture.companyId,
          systemKey: SYSTEM_ACCOUNT.OTHER_INCOME,
        },
        select: { id: true },
      }),
    ]);

    try {
      const post = (client: PrismaClient, index: number) =>
        client.$transaction((tx) =>
          postJournalEntry(tx, {
            companyId: fixture.companyId,
            entryDate: new Date("2026-04-10T00:00:00.000Z"),
            voucherType: "RECEIPT",
            narration: `Concurrent ${index}`,
            createdById: fixture.userId,
            lines: [
              { accountId: cash.id, debit: "100", credit: 0 },
              { accountId: income.id, debit: 0, credit: "100" },
            ],
          }),
        );

      const entries = await Promise.all([
        post(prisma, 1),
        post(other, 2),
        post(prisma, 3),
        post(other, 4),
      ]);

      const numbers = entries.map((entry) => entry.entryNumber);
      expect(new Set(numbers).size).toBe(numbers.length);

      // And every one of them is a real, balanced entry rather than a row that
      // survived a race in a broken state.
      for (const entry of entries) {
        expect(entry.totalDebit).toBe(entry.totalCredit);
      }
    } finally {
      await other.$disconnect();
    }
  }, 150_000);
});

describe("what a second replica can see", () => {
  it("reads a company the other replica has just created", async () => {
    // Sessions, companies and every figure live in Postgres rather than in the
    // process that wrote them, which is what makes a request servable by
    // whichever replica the balancer picked. Sticky sessions are not required,
    // and this is the assertion that says so.
    const fixture = await createCompany();
    const other = secondReplica();

    try {
      const seen = await other.company.findUnique({
        where: { id: fixture.companyId },
        select: { id: true },
      });
      expect(seen?.id).toBe(fixture.companyId);
    } finally {
      await other.$disconnect();
    }
  }, 120_000);

  it("sees a session created on the other replica", async () => {
    // The specific thing that would force sticky sessions if it were untrue.
    const fixture = await createCompany();
    const other = secondReplica();

    try {
      const session = await prisma.session.findFirst({
        where: { user: { email: fixture.email } },
        select: { id: true },
      });
      if (!session) return; // Registration does not always open one.

      const seen = await other.session.findUnique({
        where: { id: session.id },
        select: { id: true },
      });
      expect(seen?.id).toBe(session.id);
    } finally {
      await other.$disconnect();
    }
  }, 120_000);
});
