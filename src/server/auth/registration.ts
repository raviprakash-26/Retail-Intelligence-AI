import "server-only";
import { UserStatus, VoucherType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { expiresAt, issueToken, TOKEN_TTL } from "@/lib/auth/tokens";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { SYSTEM_ROLE } from "@/lib/rbac/permissions";
import { add, isPositive, toStorageString } from "@/lib/money";
import { findStateByCode } from "@/lib/constants/india";
import type { RegisterInput } from "@/lib/validation/auth";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import { AUDIT_ACTION, recordAuditLog } from "@/server/audit/audit-log";

/**
 * Registration.
 *
 * Creating an account and creating a business are one operation, not two. A
 * user with no company cannot record anything, and a company with no owner is
 * unreachable — so both, plus the chart of accounts, the fiscal calendar, the
 * roles and the opening balances, are written inside a single transaction.
 * Anything that fails rolls the whole thing back.
 */

export type RegistrationResult = {
  userId: string;
  companyId: string;
  companySlug: string;
  /** Raw token for the verification email. Never persisted. */
  verificationToken: string;
  openingEntryNumber: string | null;
};

export class EmailAlreadyRegisteredError extends Error {
  constructor(readonly email: string) {
    super("An account already exists for this email address.");
    this.name = "EmailAlreadyRegisteredError";
  }
}

/**
 * Turns a business name into a URL-safe, unique slug.
 *
 * Uniqueness is settled by the database's unique index, not by this function —
 * two simultaneous registrations of "Ravi Stores" would both see the name free.
 * The retry loop in `registerOwner` handles the collision.
 */
export function slugifyCompanyName(name: string, suffix?: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  const safe = base.length >= 2 ? base : "business";
  return suffix ? `${safe}-${suffix}` : safe;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}

export async function registerOwner(
  input: RegisterInput,
  context: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<RegistrationResult> {
  const { account, business, accounting } = input;

  // Checked up front for a clear message. The unique index on `users.email` is
  // what actually guarantees it — this read is not inside the transaction that
  // writes, so two simultaneous signups both passing here is possible, and the
  // constraint violation below is the real defence.
  const existing = await prisma.user.findUnique({
    where: { email: account.email },
    select: { id: true },
  });
  if (existing) {
    throw new EmailAlreadyRegisteredError(account.email);
  }

  const passwordHash = await hashPassword(account.password);
  const { token: verificationToken, tokenHash } = issueToken();
  const now = new Date();

  const stateName = findStateByCode(business.stateCode)?.name ?? null;

  // Retry only on slug collision. Any other failure propagates.
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = slugifyCompanyName(
      business.businessName,
      attempt === 0 ? undefined : randomSuffix(),
    );

    try {
      return await prisma.$transaction(
        async (tx) => {
          const user = await tx.user.create({
            data: {
              email: account.email,
              fullName: account.fullName,
              mobile: account.mobile,
              passwordHash,
              status: UserStatus.PENDING_VERIFICATION,
            },
            select: { id: true },
          });

          const provisioned = await provisionCompany(tx, {
            name: business.businessName,
            slug,
            businessType: business.businessType,
            gstRegistration: business.gstRegistration,
            gstin: business.gstin || null,
            pan: business.pan || null,
            addressLine1: business.addressLine1,
            city: business.city,
            state: stateName,
            stateCode: business.stateCode,
            pincode: business.pincode,
            email: account.email,
            phone: account.mobile,
            currency: accounting.currency,
            fiscalYearStartMonth: accounting.fiscalYearStartMonth,
            inventoryMethod: accounting.inventoryMethod,
            isDemo: false,
            asOf: now,
          });

          const ownerRoleId = provisioned.roleIdsByKey.get(SYSTEM_ROLE.OWNER);
          if (!ownerRoleId) {
            throw new Error("Provisioning did not create the Owner role.");
          }

          await tx.membership.create({
            data: {
              userId: user.id,
              companyId: provisioned.companyId,
              roleId: ownerRoleId,
              status: "ACTIVE",
              joinedAt: now,
            },
          });

          await tx.user.update({
            where: { id: user.id },
            data: { defaultCompanyId: provisioned.companyId },
          });

          await tx.verificationToken.create({
            data: {
              tokenHash,
              purpose: "EMAIL_VERIFICATION",
              userId: user.id,
              email: account.email,
              expiresAt: expiresAt(TOKEN_TTL.EMAIL_VERIFICATION_MS, now),
            },
          });

          const openingEntryNumber = await postOpeningBalances(tx, {
            companyId: provisioned.companyId,
            branchId: provisioned.branchId,
            accounts: provisioned.accountsBySystemKey,
            cash: accounting.openingCashBalance,
            bank: accounting.openingBankBalance,
            fiscalYearStartMonth: accounting.fiscalYearStartMonth,
            userId: user.id,
            asOf: now,
          });

          // Written inside the transaction: if the company is rolled back, the
          // record of its creation must go with it.
          await recordAuditLog(
            {
              action: AUDIT_ACTION.REGISTER,
              module: "Auth",
              companyId: provisioned.companyId,
              userId: user.id,
              actorEmail: account.email,
              entityType: "Company",
              entityId: provisioned.companyId,
              metadata: {
                businessName: business.businessName,
                businessType: business.businessType,
                gstRegistration: business.gstRegistration,
                stateCode: business.stateCode,
              },
              ipAddress: context.ipAddress,
              userAgent: context.userAgent,
            },
            tx,
          );

          return {
            userId: user.id,
            companyId: provisioned.companyId,
            companySlug: slug,
            verificationToken,
            openingEntryNumber,
          };
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      lastError = error;
      if (!isSlugCollision(error)) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Could not allocate a unique company identifier.");
}

/** Prisma P2002 on `companies.slug`. */
function isSlugCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: string; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") return false;
  const target = candidate.meta?.target;
  return Array.isArray(target)
    ? target.includes("slug")
    : String(target ?? "").includes("slug");
}

/**
 * Posts the opening entry.
 *
 * Capital is the sum of the assets introduced, which is what makes the entry
 * balance without a plug figure. Nothing is posted when no assets were listed —
 * an empty opening entry would be noise in the journal.
 */
async function postOpeningBalances(
  tx: Parameters<typeof postJournalEntry>[0],
  params: {
    companyId: string;
    branchId: string;
    accounts: Map<string, string>;
    cash: number;
    bank: number;
    fiscalYearStartMonth: number;
    userId: string;
    asOf: Date;
  },
): Promise<string | null> {
  const total = add(params.cash, params.bank);
  if (!isPositive(total)) return null;

  const accountId = (key: string) => {
    const id = params.accounts.get(key);
    if (!id) throw new Error(`Opening balances: missing system account ${key}`);
    return id;
  };

  const lines: Array<{
    accountId: string;
    debit?: string;
    credit?: string;
    narration: string;
  }> = [];

  if (isPositive(params.cash)) {
    lines.push({
      accountId: accountId(SYSTEM_ACCOUNT.CASH),
      debit: toStorageString(params.cash),
      narration: "Opening cash in hand",
    });
  }
  if (isPositive(params.bank)) {
    lines.push({
      accountId: accountId(SYSTEM_ACCOUNT.BANK),
      debit: toStorageString(params.bank),
      narration: "Opening bank balance",
    });
  }

  lines.push({
    accountId: accountId(SYSTEM_ACCOUNT.OWNER_CAPITAL),
    credit: toStorageString(total),
    narration: "Owner's capital introduced",
  });

  // Dated to the first day of the fiscal year so the opening position sits
  // before every transaction the business will record, not on the signup date.
  const entryDate = openingEntryDate(params.asOf, params.fiscalYearStartMonth);

  const entry = await postJournalEntry(tx, {
    companyId: params.companyId,
    branchId: params.branchId,
    entryDate,
    voucherType: VoucherType.OPENING_BALANCE,
    narration: "Opening balances on setup",
    isSystem: true,
    createdById: params.userId,
    sourceType: "OPENING_BALANCE",
    lines,
  });

  // Mirror the figures onto the accounts so a ledger can show an opening
  // balance without replaying the journal.
  await tx.account.update({
    where: { id: accountId(SYSTEM_ACCOUNT.OWNER_CAPITAL) },
    data: { openingBalance: toStorageString(total), openingNature: "CREDIT" },
  });
  if (isPositive(params.cash)) {
    await tx.account.update({
      where: { id: accountId(SYSTEM_ACCOUNT.CASH) },
      data: {
        openingBalance: toStorageString(params.cash),
        openingNature: "DEBIT",
      },
    });
  }
  if (isPositive(params.bank)) {
    await tx.account.update({
      where: { id: accountId(SYSTEM_ACCOUNT.BANK) },
      data: {
        openingBalance: toStorageString(params.bank),
        openingNature: "DEBIT",
      },
    });
  }

  return entry.entryNumber;
}

/** First day of the fiscal year containing `asOf`. */
export function openingEntryDate(asOf: Date, startMonth: number): Date {
  const month = asOf.getUTCMonth() + 1;
  const year = asOf.getUTCFullYear();
  const startYear = month >= startMonth ? year : year - 1;
  return new Date(Date.UTC(startYear, startMonth - 1, 1));
}
