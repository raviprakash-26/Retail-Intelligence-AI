import "server-only";
import { prisma } from "@/lib/db";
import { findStateByCode } from "@/lib/constants/india";
import type {
  CompanyAccountingInput,
  CompanyProfileInput,
} from "@/lib/validation/company";
import { AUDIT_ACTION, recordAuditLog } from "@/server/audit/audit-log";

/**
 * Company settings.
 *
 * The profile can be edited whenever. The accounting settings cannot: once a
 * transaction is posted, changing the fiscal year would orphan its periods,
 * changing the currency would silently reinterpret every stored amount, and
 * changing the stock valuation method would make historical cost of goods sold
 * irreproducible.
 *
 * Rather than silently ignoring those edits — or worse, applying them — the
 * service reports exactly which fields are locked and why, so the interface can
 * explain it and the user is not left wondering why their change did not stick.
 */

export const SETTINGS_AUDIT = {
  PROFILE_UPDATED: "company.profile_updated",
  ACCOUNTING_UPDATED: "company.accounting_updated",
  GST_REGISTRATION_CHANGED: "company.gst_registration_changed",
} as const;

export type AccountingLock = {
  field: "fiscalYearStartMonth" | "currency" | "inventoryMethod";
  locked: boolean;
  reason: string | null;
};

export type AccountingLocks = {
  postedEntryCount: number;
  stockMovementCount: number;
  locks: AccountingLock[];
};

/** Which accounting settings are still safe to change, and why not. */
export async function describeAccountingLocks(
  companyId: string,
): Promise<AccountingLocks> {
  const [postedEntryCount, stockMovementCount] = await Promise.all([
    prisma.journalEntry.count({
      where: { companyId, status: { in: ["POSTED", "VOIDED", "REVERSED"] } },
    }),
    prisma.inventoryMovement.count({ where: { companyId } }),
  ]);

  const hasLedger = postedEntryCount > 0;
  const hasStock = stockMovementCount > 0;

  return {
    postedEntryCount,
    stockMovementCount,
    locks: [
      {
        field: "fiscalYearStartMonth",
        locked: hasLedger,
        reason: hasLedger
          ? `Your books already contain ${postedEntryCount} posted ${
              postedEntryCount === 1 ? "entry" : "entries"
            }. Moving the financial year would leave them outside any accounting period.`
          : null,
      },
      {
        field: "currency",
        locked: hasLedger,
        reason: hasLedger
          ? "Amounts are already recorded in your current currency. Changing it would relabel them rather than convert them."
          : null,
      },
      {
        field: "inventoryMethod",
        locked: hasStock,
        reason: hasStock
          ? `Stock has already moved ${stockMovementCount} ${
              stockMovementCount === 1 ? "time" : "times"
            }. Changing the valuation method would make past cost of goods sold irreproducible.`
          : null,
      },
    ],
  };
}

export function isLocked(
  locks: AccountingLocks,
  field: AccountingLock["field"],
) {
  return locks.locks.find((lock) => lock.field === field)?.locked ?? false;
}

export type SettingsUpdateResult =
  | { ok: true; ignoredFields: string[] }
  | { ok: false; fieldErrors: Record<string, string> };

export async function updateCompanyProfile(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: CompanyProfileInput;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<SettingsUpdateResult> {
  const { companyId, input } = params;

  const before = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: {
      name: true,
      legalName: true,
      businessType: true,
      gstRegistration: true,
      gstin: true,
      pan: true,
      addressLine1: true,
      city: true,
      stateCode: true,
      pincode: true,
    },
  });

  const stateName = findStateByCode(input.stateCode)?.name ?? null;

  await prisma.company.update({
    where: { id: companyId },
    data: {
      name: input.name,
      legalName: input.legalName || input.name,
      businessType: input.businessType,
      gstRegistration: input.gstRegistration,
      gstin: input.gstin || null,
      pan: input.pan || null,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2 || null,
      city: input.city,
      state: stateName,
      stateCode: input.stateCode,
      pincode: input.pincode,
      phone: input.phone || null,
      email: input.email || null,
      website: input.website || null,
    },
  });

  // The GST registration and GSTIN determine how every future invoice is
  // taxed, so a change to either is logged as its own event rather than being
  // buried in a general "profile updated".
  const gstChanged =
    before.gstRegistration !== input.gstRegistration ||
    (before.gstin ?? "") !== (input.gstin ?? "") ||
    before.stateCode !== input.stateCode;

  if (gstChanged) {
    await recordAuditLog({
      action: SETTINGS_AUDIT.GST_REGISTRATION_CHANGED,
      module: "Settings",
      companyId,
      userId: params.userId,
      actorEmail: params.actorEmail,
      entityType: "Company",
      entityId: companyId,
      metadata: {
        from: {
          gstRegistration: before.gstRegistration,
          gstin: before.gstin,
          stateCode: before.stateCode,
        },
        to: {
          gstRegistration: input.gstRegistration,
          gstin: input.gstin || null,
          stateCode: input.stateCode,
        },
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  await recordAuditLog({
    action: SETTINGS_AUDIT.PROFILE_UPDATED,
    module: "Settings",
    companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Company",
    entityId: companyId,
    metadata: { changed: changedKeys(before, input) },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return { ok: true, ignoredFields: [] };
}

/**
 * Applies accounting settings, silently keeping any locked field at its
 * current value and reporting which were ignored.
 *
 * Reporting rather than rejecting: a user editing the timezone should not have
 * their whole save fail because the fiscal-year select happened to be posted
 * back unchanged-but-locked.
 */
export async function updateCompanyAccounting(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: CompanyAccountingInput;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<SettingsUpdateResult> {
  const { companyId, input } = params;

  const [current, locks] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: {
        fiscalYearStartMonth: true,
        currency: true,
        inventoryMethod: true,
        timezone: true,
      },
    }),
    describeAccountingLocks(companyId),
  ]);

  const ignoredFields: string[] = [];

  const resolve = <T>(
    field: AccountingLock["field"],
    next: T,
    existing: T,
  ): T => {
    if (!isLocked(locks, field)) return next;
    if (next !== existing) ignoredFields.push(field);
    return existing;
  };

  const data = {
    fiscalYearStartMonth: resolve(
      "fiscalYearStartMonth",
      input.fiscalYearStartMonth,
      current.fiscalYearStartMonth,
    ),
    currency: resolve("currency", input.currency, current.currency),
    inventoryMethod: resolve(
      "inventoryMethod",
      input.inventoryMethod,
      current.inventoryMethod,
    ),
    timezone: input.timezone,
  };

  await prisma.company.update({ where: { id: companyId }, data });

  await recordAuditLog({
    action: SETTINGS_AUDIT.ACCOUNTING_UPDATED,
    module: "Settings",
    companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Company",
    entityId: companyId,
    metadata: {
      changed: changedKeys(current, data),
      ignoredBecauseLocked: ignoredFields,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return { ok: true, ignoredFields };
}

/** Keys whose value differs between two shallow records. */
function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return Object.keys(after).filter((key) => {
    if (!(key in before)) return false;
    const previous = before[key] ?? "";
    const next = after[key] ?? "";
    return String(previous) !== String(next);
  });
}

export { AUDIT_ACTION };
