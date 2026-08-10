import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { hashToken, issueToken } from "@/lib/auth/tokens";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import type { RegisterInput } from "@/lib/validation/auth";
import {
  EmailAlreadyRegisteredError,
  openingEntryDate,
  registerOwner,
  slugifyCompanyName,
} from "@/server/auth/registration";
import { resetAllRateLimitsForTests } from "@/server/security/rate-limit";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Registration and credential handling against a real database.
 *
 * The server actions themselves need a Next.js request scope (cookies,
 * headers), which is not available under Vitest. So these exercise the layer
 * directly beneath: the registration transaction, the token lifecycle and the
 * password/session invariants the actions orchestrate. The action wiring on top
 * is verified by the end-to-end browser pass.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function registrationInput(
  overrides: Partial<RegisterInput> = {},
): RegisterInput {
  const unique = uniqueSlug("owner").replace(/-/g, "");
  const email = `${unique}@example.com`;
  createdEmails.push(email);

  return {
    account: {
      fullName: "Ravi Prakash",
      email,
      mobile: "9845012345",
      password: "MountainRiver42!",
      confirmPassword: "MountainRiver42!",
      acceptTerms: true,
      ...overrides.account,
    },
    business: {
      businessName: "Ravi Retail Mart",
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: "29AAAPR1234K1ZP",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
      ...overrides.business,
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 45_000,
      openingBankBalance: 285_000,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
      ...overrides.accounting,
    },
  };
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

beforeEach(() => {
  resetAllRateLimitsForTests();
});

afterAll(async () => {
  for (const companyId of createdCompanies) {
    await purgeTestCompany(companyId).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("registration", () => {
  it("creates the user, the company and the owner membership together", async () => {
    const input = registrationInput();
    const result = await registerOwner(input);
    createdCompanies.push(result.companyId);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: {
        email: true,
        status: true,
        passwordHash: true,
        defaultCompanyId: true,
        emailVerifiedAt: true,
      },
    });

    expect(user.email).toBe(input.account.email);
    expect(user.status).toBe("PENDING_VERIFICATION");
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.defaultCompanyId).toBe(result.companyId);

    // The plaintext must never be recoverable from what was stored.
    expect(user.passwordHash).not.toBe(input.account.password);
    expect(user.passwordHash.startsWith("$2")).toBe(true);
    expect(
      await bcrypt.compare(input.account.password, user.passwordHash),
    ).toBe(true);

    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: result.userId, companyId: result.companyId },
      select: { status: true, role: { select: { key: true } } },
    });
    expect(membership.status).toBe("ACTIVE");
    expect(membership.role.key).toBe("owner");
  }, 60_000);

  it("provisions a complete chart of accounts and fiscal calendar", async () => {
    const result = await registerOwner(registrationInput());
    createdCompanies.push(result.companyId);

    const [accounts, periods, taxRates, sequences, subscription] =
      await Promise.all([
        prisma.account.count({ where: { companyId: result.companyId } }),
        prisma.fiscalPeriod.count({ where: { companyId: result.companyId } }),
        prisma.taxRate.count({ where: { companyId: result.companyId } }),
        prisma.documentSequence.count({
          where: { companyId: result.companyId },
        }),
        prisma.subscription.findUnique({
          where: { companyId: result.companyId },
          select: { status: true },
        }),
      ]);

    expect(accounts).toBeGreaterThan(40);
    expect(periods).toBe(12);
    expect(taxRates).toBe(5);
    expect(sequences).toBeGreaterThan(5);
    expect(subscription?.status).toBe("TRIALING");
  }, 60_000);

  it("posts a balanced opening entry from the assets introduced", async () => {
    const result = await registerOwner(registrationInput());
    createdCompanies.push(result.companyId);

    expect(result.openingEntryNumber).toBeTruthy();

    const lines = await prisma.journalLine.findMany({
      where: { companyId: result.companyId, status: "POSTED" },
      select: {
        debit: true,
        credit: true,
        account: { select: { systemKey: true } },
      },
    });

    const balance = trialBalanceIsBalanced(lines);
    expect(balance.balanced).toBe(true);

    // Capital equals cash + bank, by construction rather than by a plug figure.
    expect(balance.totalDebit.toString()).toBe("330000");

    const capitalLine = lines.find(
      (line) => line.account.systemKey === SYSTEM_ACCOUNT.OWNER_CAPITAL,
    );
    expect(capitalLine?.credit.toString()).toBe("330000");
  }, 60_000);

  it("dates the opening entry to the start of the fiscal year", async () => {
    const result = await registerOwner(registrationInput());
    createdCompanies.push(result.companyId);

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: result.companyId, voucherType: "OPENING_BALANCE" },
      select: { entryDate: true },
    });

    // April start: the entry belongs on 1 April, not on the signup date.
    expect(entry.entryDate.toISOString().slice(5, 10)).toBe("04-01");
  }, 60_000);

  it("posts no opening entry when no assets were listed", async () => {
    const result = await registerOwner(
      registrationInput({
        accounting: {
          fiscalYearStartMonth: 4,
          currency: "INR",
          openingCashBalance: 0,
          openingBankBalance: 0,
          inventoryMethod: "WEIGHTED_AVERAGE",
          loadDemoData: false,
        },
      }),
    );
    createdCompanies.push(result.companyId);

    expect(result.openingEntryNumber).toBeNull();
    expect(
      await prisma.journalEntry.count({
        where: { companyId: result.companyId },
      }),
    ).toBe(0);
  }, 60_000);

  it("issues a single-use email verification token, stored only as a hash", async () => {
    const result = await registerOwner(registrationInput());
    createdCompanies.push(result.companyId);

    const token = await prisma.verificationToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(result.verificationToken) },
      select: {
        purpose: true,
        consumedAt: true,
        expiresAt: true,
        tokenHash: true,
      },
    });

    expect(token.purpose).toBe("EMAIL_VERIFICATION");
    expect(token.consumedAt).toBeNull();
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // The raw token must not be recoverable from the row.
    expect(token.tokenHash).not.toBe(result.verificationToken);
  }, 60_000);

  it("records the registration in the audit log", async () => {
    const input = registrationInput();
    const result = await registerOwner(input, { ipAddress: "203.0.113.5" });
    createdCompanies.push(result.companyId);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { companyId: result.companyId, action: "auth.register" },
      select: { actorEmail: true, ipAddress: true, metadata: true },
    });

    expect(log.actorEmail).toBe(input.account.email);
    expect(log.ipAddress).toBe("203.0.113.5");
    // Nothing credential-shaped may reach a table that cannot be deleted from.
    expect(JSON.stringify(log.metadata)).not.toContain(input.account.password);
  }, 60_000);

  it("rejects a duplicate email address", async () => {
    const input = registrationInput();
    const first = await registerOwner(input);
    createdCompanies.push(first.companyId);

    await expect(registerOwner(input)).rejects.toBeInstanceOf(
      EmailAlreadyRegisteredError,
    );
  }, 60_000);

  it("gives two businesses with the same name distinct slugs", async () => {
    const first = await registerOwner(registrationInput());
    createdCompanies.push(first.companyId);

    const second = await registerOwner(registrationInput());
    createdCompanies.push(second.companyId);

    expect(first.companySlug).not.toBe(second.companySlug);
  }, 90_000);

  it("leaves nothing behind when the transaction fails", async () => {
    const input = registrationInput({
      // No such state code, so provisioning proceeds but the GSTIN state
      // lookup yields null — the failure we force is a bad fiscal month.
      accounting: {
        fiscalYearStartMonth: 99,
        currency: "INR",
        openingCashBalance: 1000,
        openingBankBalance: 0,
        inventoryMethod: "WEIGHTED_AVERAGE",
        loadDemoData: false,
      },
    });

    await expect(registerOwner(input)).rejects.toThrow();

    // The user row must have rolled back with the company.
    const user = await prisma.user.findUnique({
      where: { email: input.account.email },
      select: { id: true },
    });
    expect(user).toBeNull();
  }, 60_000);
});

describe("slug generation", () => {
  it("produces a URL-safe slug", () => {
    expect(slugifyCompanyName("Ravi Retail Mart")).toBe("ravi-retail-mart");
    expect(slugifyCompanyName("  Sharma & Sons  ")).toBe("sharma-sons");
    expect(slugifyCompanyName("M/s. Kumar Traders (Pvt) Ltd")).toBe(
      "m-s-kumar-traders-pvt-ltd",
    );
  });

  it("falls back for a name with no usable characters", () => {
    expect(slugifyCompanyName("!!!")).toBe("business");
    expect(slugifyCompanyName("")).toBe("business");
  });

  it("appends a suffix when asked", () => {
    expect(slugifyCompanyName("Ravi Retail Mart", "x7k2p")).toBe(
      "ravi-retail-mart-x7k2p",
    );
  });

  it("caps the length", () => {
    expect(slugifyCompanyName("A".repeat(200)).length).toBeLessThanOrEqual(48);
  });
});

describe("opening entry date", () => {
  it("uses the fiscal year containing the date", () => {
    expect(
      openingEntryDate(new Date("2026-08-09T00:00:00Z"), 4)
        .toISOString()
        .slice(0, 10),
    ).toBe("2026-04-01");
  });

  it("uses the previous fiscal year for a January signup", () => {
    expect(
      openingEntryDate(new Date("2026-01-15T00:00:00Z"), 4)
        .toISOString()
        .slice(0, 10),
    ).toBe("2025-04-01");
  });

  it("supports a January fiscal start", () => {
    expect(
      openingEntryDate(new Date("2026-08-09T00:00:00Z"), 1)
        .toISOString()
        .slice(0, 10),
    ).toBe("2026-01-01");
  });
});

describe("token lifecycle", () => {
  it("stores only a digest that cannot be reversed to the token", () => {
    const { token, tokenHash } = issueToken();
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toHaveLength(64);
    expect(hashToken(token)).toBe(tokenHash);
  });

  it("produces a distinct token every time", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => issueToken().token),
    );
    expect(tokens.size).toBe(200);
  });

  it("produces tokens with meaningful entropy", () => {
    // 32 random bytes, base64url encoded, is 43 characters.
    expect(issueToken().token.length).toBeGreaterThanOrEqual(43);
  });
});
