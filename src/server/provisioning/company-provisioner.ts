import "server-only";
import {
  AccountNature,
  BillingInterval,
  BusinessType,
  CompanyStatus,
  GstRegistrationType,
  InventoryValuationMethod,
  SubscriptionStatus,
} from "@prisma/client";
import type { DbClient } from "@/lib/db";
import {
  DEFAULT_ACCOUNT_GROUPS,
  DEFAULT_ACCOUNTS,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_TAX_RATES,
  DEFAULT_UNITS,
} from "@/lib/accounting/chart-of-accounts";
import { COMPANY_SERIES, SEQUENCE_PADDING } from "@/lib/documents/sequences";
import { DEFAULT_TRIAL_PLAN_KEY } from "@/lib/billing/plans";
import { createFiscalYear } from "@/server/fiscal/fiscal-calendar";

/**
 * Provisions everything a new tenant needs before it can record a transaction.
 *
 * This is the single implementation used by both the demo seed and the
 * registration flow — a company created by either route is structurally
 * identical, so a bug found in one is not still lurking in the other.
 *
 * The caller supplies the transaction client. Provisioning must be atomic: a
 * company with accounts but no fiscal year, or with a fiscal year but no
 * chart of accounts, cannot post anything and is worse than no company at all.
 */

export type ProvisionCompanyInput = {
  name: string;
  legalName?: string;
  slug: string;
  businessType?: BusinessType;
  gstRegistration?: GstRegistrationType;
  gstin?: string | null;
  pan?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
  currency?: string;
  fiscalYearStartMonth?: number;
  inventoryMethod?: InventoryValuationMethod;
  isDemo?: boolean;
  /** Anchors the fiscal year. Defaults to now; pinned in tests and seeds. */
  asOf?: Date;
  /**
   * The day the books open, which is where the fiscal calendar starts.
   *
   * Defaults to `asOf`, which is what a real signup wants: a business that
   * starts today starts its books today. The demo shop is the exception — it
   * arrives with months of history, so its books open before the account does,
   * while the trial still starts on the day the seed runs.
   */
  booksOpenedOn?: Date;
};

export type ProvisionedCompany = {
  companyId: string;
  branchId: string;
  fiscalYearId: string;
  /** systemKey → account id, for the caller to post opening balances with. */
  accountsBySystemKey: Map<string, string>;
  /** code → tax rate id. */
  taxRatesByCode: Map<string, string>;
  /** code → unit id. */
  unitsByCode: Map<string, string>;
  /** name → expense category id. */
  expenseCategoriesByName: Map<string, string>;
  roleIdsByKey: Map<string, string>;
};

export async function provisionCompany(
  tx: DbClient,
  input: ProvisionCompanyInput,
): Promise<ProvisionedCompany> {
  const asOf = input.asOf ?? new Date();
  const fiscalStartMonth = input.fiscalYearStartMonth ?? 4;

  const company = await tx.company.create({
    data: {
      name: input.name,
      legalName: input.legalName ?? input.name,
      slug: input.slug,
      businessType: input.businessType ?? BusinessType.SOLE_PROPRIETORSHIP,
      status: CompanyStatus.ACTIVE,
      gstRegistration:
        input.gstRegistration ?? GstRegistrationType.UNREGISTERED,
      gstin: input.gstin ?? null,
      pan: input.pan ?? null,
      addressLine1: input.addressLine1 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      stateCode: input.stateCode ?? null,
      pincode: input.pincode ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      currency: input.currency ?? "INR",
      fiscalYearStartMonth: fiscalStartMonth,
      inventoryMethod:
        input.inventoryMethod ?? InventoryValuationMethod.WEIGHTED_AVERAGE,
      isDemo: input.isDemo ?? false,
      onboardedAt: asOf,
      onboardingStep: 3,
    },
    select: { id: true },
  });

  const companyId = company.id;

  // --- Branch -------------------------------------------------------------
  const branch = await tx.branch.create({
    data: {
      companyId,
      code: "MAIN",
      name: "Main Branch",
      addressLine1: input.addressLine1 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      stateCode: input.stateCode ?? null,
      pincode: input.pincode ?? null,
      isPrimary: true,
    },
    select: { id: true },
  });

  // --- Fiscal calendar ----------------------------------------------------
  // The first year is opened by the same function that opens every later one,
  // so a company's first April and its tenth produce the same rows.
  const fiscalYear = await createFiscalYear(tx, {
    companyId,
    anchor: input.booksOpenedOn ?? asOf,
    startMonth: fiscalStartMonth,
    isCurrent: true,
  });
  const start = fiscalYear.startDate;

  // --- Chart of accounts --------------------------------------------------
  // Groups are inserted parents-first so the self-referencing FK resolves.
  const groupIdsByCode = new Map<string, string>();

  const orderedGroups = [...DEFAULT_ACCOUNT_GROUPS].sort((a, b) => {
    const depth = (group: (typeof DEFAULT_ACCOUNT_GROUPS)[number]) =>
      group.parentCode ? 1 : 0;
    return depth(a) - depth(b) || a.sortOrder - b.sortOrder;
  });

  // Two passes: roots, then children, then grandchildren. The default chart is
  // three levels deep, and sorting alone does not guarantee a parent precedes
  // its child across levels.
  const remaining = [...orderedGroups];
  let guard = 0;
  while (remaining.length > 0 && guard < 10) {
    guard += 1;
    const insertable = remaining.filter(
      (group) => !group.parentCode || groupIdsByCode.has(group.parentCode),
    );
    if (insertable.length === 0) {
      throw new Error(
        `Chart of accounts has an unresolvable group parent: ${remaining
          .map((group) => group.code)
          .join(", ")}`,
      );
    }

    for (const group of insertable) {
      const created = await tx.accountGroup.create({
        data: {
          companyId,
          parentId: group.parentCode
            ? (groupIdsByCode.get(group.parentCode) ?? null)
            : null,
          code: group.code,
          name: group.name,
          type: group.type,
          nature: group.nature,
          section: group.section,
          sortOrder: group.sortOrder,
          isSystem: true,
        },
        select: { id: true },
      });
      groupIdsByCode.set(group.code, created.id);
    }

    for (const group of insertable) {
      remaining.splice(remaining.indexOf(group), 1);
    }
  }

  await tx.account.createMany({
    data: DEFAULT_ACCOUNTS.map((account) => {
      const groupId = groupIdsByCode.get(account.groupCode);
      if (!groupId) {
        throw new Error(
          `Account ${account.code} references unknown group ${account.groupCode}`,
        );
      }
      return {
        companyId,
        groupId,
        code: account.code,
        name: account.name,
        type: account.type,
        subType: account.subType,
        nature: account.nature,
        section: account.section,
        systemKey: account.systemKey ?? null,
        description: account.description ?? null,
        partyType: account.partyType ?? null,
        isSystem: true,
        openingBalance: 0,
        openingNature: account.nature,
      };
    }),
  });

  const accounts = await tx.account.findMany({
    where: { companyId, systemKey: { not: null } },
    select: { id: true, systemKey: true },
  });
  const accountsBySystemKey = new Map(
    accounts.flatMap((account) =>
      account.systemKey ? [[account.systemKey, account.id] as const] : [],
    ),
  );

  // --- Expense categories -------------------------------------------------
  await tx.expenseCategory.createMany({
    data: DEFAULT_EXPENSE_CATEGORIES.map((category) => ({
      companyId,
      name: category.name,
      accountId: accountsBySystemKey.get(category.accountKey) ?? null,
      isSystem: true,
    })),
  });

  const expenseCategories = await tx.expenseCategory.findMany({
    where: { companyId },
    select: { id: true, name: true },
  });

  // --- Tax rates ----------------------------------------------------------
  // Effective from the start of the fiscal year so historical documents in the
  // demo dataset resolve a rate. A later rate change adds a new version rather
  // than editing these rows.
  await tx.taxRate.createMany({
    data: DEFAULT_TAX_RATES.map((rate) => ({
      companyId,
      code: rate.code,
      name: rate.name,
      ratePercent: rate.ratePercent,
      cgstPercent: rate.ratePercent / 2,
      sgstPercent: rate.ratePercent / 2,
      igstPercent: rate.ratePercent,
      cessPercent: 0,
      effectiveFrom: start,
      version: 1,
      isActive: true,
      isSystem: true,
    })),
  });

  const taxRates = await tx.taxRate.findMany({
    where: { companyId },
    select: { id: true, code: true },
  });

  // --- Units --------------------------------------------------------------
  await tx.unit.createMany({
    data: DEFAULT_UNITS.map((unit) => ({
      companyId,
      code: unit.code,
      name: unit.name,
      precision: unit.precision,
    })),
  });

  const units = await tx.unit.findMany({
    where: { companyId },
    select: { id: true, code: true },
  });

  // --- Roles --------------------------------------------------------------
  // Each company gets its own copy of the system roles, so a tenant can adjust
  // a role's permissions without affecting anyone else.
  const templates = await tx.role.findMany({
    where: { companyId: null, isSystem: true },
    select: {
      key: true,
      name: true,
      description: true,
      permissions: { select: { permissionId: true } },
    },
  });

  if (templates.length === 0) {
    throw new Error(
      "System role templates are missing. Run the platform seed before provisioning a company.",
    );
  }

  const roleIdsByKey = new Map<string, string>();
  for (const template of templates) {
    const role = await tx.role.create({
      data: {
        companyId,
        key: template.key,
        name: template.name,
        description: template.description,
        isSystem: true,
      },
      select: { id: true },
    });
    roleIdsByKey.set(template.key, role.id);

    if (template.permissions.length > 0) {
      await tx.rolePermission.createMany({
        data: template.permissions.map((permission) => ({
          roleId: role.id,
          permissionId: permission.permissionId,
        })),
        skipDuplicates: true,
      });
    }
  }

  // --- Document sequences -------------------------------------------------
  // Voucher series belong to a fiscal year and were created with it above.
  // These are the master-record series, which run for the life of the tenant.
  await tx.documentSequence.createMany({
    data: COMPANY_SERIES.map((series) => ({
      companyId,
      fiscalYearId: null,
      key: series.key,
      prefix: series.prefix,
      padding: SEQUENCE_PADDING,
      nextValue: 1,
    })),
  });

  // --- Subscription -------------------------------------------------------
  const plan = await tx.subscriptionPlan.findUnique({
    where: { key: DEFAULT_TRIAL_PLAN_KEY },
    select: { id: true, trialDays: true },
  });

  if (plan) {
    const trialEnd = new Date(asOf.getTime() + plan.trialDays * 86_400_000);
    await tx.subscription.create({
      data: {
        companyId,
        planId: plan.id,
        status: SubscriptionStatus.TRIALING,
        interval: BillingInterval.MONTHLY,
        currentPeriodStart: asOf,
        currentPeriodEnd: trialEnd,
        trialEndsAt: trialEnd,
      },
    });
  }

  return {
    companyId,
    branchId: branch.id,
    fiscalYearId: fiscalYear.id,
    accountsBySystemKey,
    taxRatesByCode: new Map(taxRates.map((rate) => [rate.code, rate.id])),
    unitsByCode: new Map(units.map((unit) => [unit.code, unit.id])),
    expenseCategoriesByName: new Map(
      expenseCategories.map((category) => [category.name, category.id]),
    ),
    roleIdsByKey,
  };
}

/** Convenience for callers that need an opening-balance nature. */
export function openingNatureFor(amount: number): AccountNature {
  return amount >= 0 ? AccountNature.DEBIT : AccountNature.CREDIT;
}
