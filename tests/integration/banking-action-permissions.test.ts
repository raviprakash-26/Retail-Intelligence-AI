import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { PermissionKey } from "@/lib/rbac/permissions";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import { createBankAccount } from "@/server/banking/bank-account-service";
import { importStatement } from "@/server/banking/statement-import";
import { recordFromStatement } from "@/server/banking/record-from-statement";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Which permission unmatching asks for.
 *
 * Unmatching a line the banking module posted from reverses that entry, and
 * reversing is posting — the heavier act that `recordFromStatementAction`
 * already asks `accounting.journal.create` for. Unmatching a match somebody
 * made by hand posts nothing and rightly asks only `banking.reconcile`.
 *
 * So the action has to carry the second permission through to the service
 * rather than assume it, and that carrying is the only part of this fix that
 * lives above the service. Nothing in the service tests can see it: hand the
 * service `mayPost: true` unconditionally and every one of them still passes,
 * while a role holding `banking.reconcile` alone quietly gains the ability to
 * post. Those roles exist — `updateRole` takes any subset of the permission
 * keys, so a company can build exactly that one.
 *
 * Only the auth boundary is stubbed. The action itself is the real one.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

/** What `assertPermission` hands back for the case being run. */
let permissions = new Set<PermissionKey>();
let actor = { companyId: "", userId: "", email: "" };

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("@/server/security/request-context", () => ({
  requireSameOrigin: async () => undefined,
}));

vi.mock("@/server/auth/context", () => ({
  assertPermission: async () => ({
    company: { id: actor.companyId },
    user: { id: actor.userId, email: actor.email },
    permissions,
  }),
}));

const { unmatchTransactionAction } = await import("@/server/banking/actions");

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
      businessName: `Permit ${uniqueSlug("Mart")}`,
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
      openingBankBalance: 200_000,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

/** A company with a ₹236 bank charge already recorded from its statement. */
async function shopWithRecordedCharge(): Promise<{
  lineId: string;
  entryId: string;
}> {
  const email = `permit-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  actor = {
    companyId: result.companyId,
    userId: result.userId,
    email,
  };

  const ledger = await prisma.account.findFirstOrThrow({
    where: { companyId: result.companyId, systemKey: SYSTEM_ACCOUNT.BANK },
    select: { id: true },
  });
  const bank = await createBankAccount({
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: email,
    input: {
      name: "Current Account — Canara Bank",
      accountId: ledger.id,
      bankName: "Canara Bank",
      accountNumber: undefined,
      ifsc: undefined,
      branchName: undefined,
      type: "CURRENT",
    },
  });
  await importStatement({
    companyId: result.companyId,
    bankAccountId: bank.id,
    content: [
      "Txn Date,Description,Chq/Ref No,Withdrawal Amt,Deposit Amt",
      "10/04/2026,Quarterly charges,,236.00,",
    ].join("\n"),
    fileName: "statement.csv",
    userId: result.userId,
    actorEmail: email,
  });

  const line = await prisma.bankTransaction.findFirstOrThrow({
    where: { companyId: result.companyId },
    select: { id: true },
  });
  const posted = await recordFromStatement({
    companyId: result.companyId,
    bankTransactionId: line.id,
    kind: "BANK_CHARGE",
    userId: result.userId,
    actorEmail: email,
  });

  return { lineId: line.id, entryId: posted.entryId };
}

beforeAll(async () => {
  await ensurePlatformData();
});

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("unmatching a recorded line through the action", () => {
  it("is refused for a reconciler who cannot post", async () => {
    const { lineId, entryId } = await shopWithRecordedCharge();
    permissions = new Set<PermissionKey>(["banking.view", "banking.reconcile"]);

    const result = await unmatchTransactionAction({
      bankTransactionId: lineId,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(
      /permission to create journal entries/i,
    );

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { id: entryId },
      select: { status: true },
    });
    expect(entry.status).toBe("POSTED");
  }, 90_000);

  it("goes through for one who can", async () => {
    const { lineId, entryId } = await shopWithRecordedCharge();
    permissions = new Set<PermissionKey>([
      "banking.view",
      "banking.reconcile",
      "accounting.journal.create",
    ]);

    const result = await unmatchTransactionAction({
      bankTransactionId: lineId,
    });

    expect(result.ok).toBe(true);
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { id: entryId },
      select: { status: true },
    });
    expect(entry.status).toBe("REVERSED");
  }, 90_000);
});
