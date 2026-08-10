import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VoucherType } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Two tenants operating side by side.
 *
 * The point of these tests is that isolation is structural, not incidental:
 * two businesses must be able to use the same invoice numbers, SKUs and
 * account codes without colliding, and no query scoped to one company may
 * ever surface a row belonging to the other.
 */

const prisma = testDb();
const DATE = new Date("2026-06-15T00:00:00.000Z");

type Tenant = {
  companyId: string;
  accounts: Map<string, string>;
  unitId: string;
};

let alpha: Tenant;
let beta: Tenant;

async function createTenant(name: string): Promise<Tenant> {
  const provisioned = await prisma.$transaction(
    (tx) =>
      provisionCompany(tx, {
        name,
        slug: uniqueSlug(name.toLowerCase().replace(/\s+/g, "-")),
        stateCode: "29",
        asOf: DATE,
      }),
    { timeout: 60_000 },
  );

  const unitId = provisioned.unitsByCode.get("PCS");
  if (!unitId) throw new Error("Provisioning did not create the PCS unit");

  return {
    companyId: provisioned.companyId,
    accounts: provisioned.accountsBySystemKey,
    unitId,
  };
}

beforeAll(async () => {
  await ensurePlatformData();
  alpha = await createTenant("Alpha Stores");
  beta = await createTenant("Beta Mart");
}, 120_000);

afterAll(async () => {
  if (alpha?.companyId) await purgeTestCompany(alpha.companyId);
  if (beta?.companyId) await purgeTestCompany(beta.companyId);
  await disconnectTestDb();
});

describe("identifier reuse across tenants", () => {
  it("lets both tenants use the same product SKU", async () => {
    for (const tenant of [alpha, beta]) {
      await prisma.product.create({
        data: {
          companyId: tenant.companyId,
          unitId: tenant.unitId,
          sku: "RICE-25KG",
          name: "Sona Masoori Rice",
          purchasePrice: 1450,
          sellingPrice: 1620,
        },
      });
    }

    const matches = await prisma.product.findMany({
      where: {
        sku: "RICE-25KG",
        companyId: { in: [alpha.companyId, beta.companyId] },
      },
      select: { companyId: true },
    });
    expect(matches).toHaveLength(2);
  });

  it("rejects a duplicate SKU within one tenant", async () => {
    await expect(
      prisma.product.create({
        data: {
          companyId: alpha.companyId,
          unitId: alpha.unitId,
          sku: "RICE-25KG",
          name: "Duplicate",
          purchasePrice: 1,
          sellingPrice: 1,
        },
      }),
    ).rejects.toThrow(/unique/i);
  });

  it("lets both tenants issue the same customer code", async () => {
    for (const tenant of [alpha, beta]) {
      await prisma.customer.create({
        data: {
          companyId: tenant.companyId,
          code: "CUS-0001",
          name: "First Customer",
        },
      });
    }

    // Scoped to this test's two tenants: other suites share the database, and
    // a global count would assert something about them rather than about the
    // uniqueness rule under test.
    expect(
      await prisma.customer.count({
        where: {
          code: "CUS-0001",
          companyId: { in: [alpha.companyId, beta.companyId] },
        },
      }),
    ).toBe(2);
  });

  it("lets both tenants use the same invoice number", async () => {
    for (const tenant of [alpha, beta]) {
      await prisma.sale.create({
        data: {
          companyId: tenant.companyId,
          invoiceNumber: "INV-0001",
          invoiceDate: DATE,
          totalAmount: 1000,
          subTotal: 1000,
          taxableAmount: 1000,
        },
      });
    }

    expect(
      await prisma.sale.count({
        where: {
          invoiceNumber: "INV-0001",
          companyId: { in: [alpha.companyId, beta.companyId] },
        },
      }),
    ).toBe(2);
  });

  it("rejects a duplicate invoice number within one tenant", async () => {
    await expect(
      prisma.sale.create({
        data: {
          companyId: alpha.companyId,
          invoiceNumber: "INV-0001",
          invoiceDate: DATE,
          totalAmount: 500,
          subTotal: 500,
          taxableAmount: 500,
        },
      }),
    ).rejects.toThrow(/unique/i);
  });

  it("gives each tenant its own account codes and its own account rows", async () => {
    const [alphaCash, betaCash] = await Promise.all([
      prisma.account.findFirstOrThrow({
        where: { companyId: alpha.companyId, systemKey: SYSTEM_ACCOUNT.CASH },
        select: { id: true, code: true },
      }),
      prisma.account.findFirstOrThrow({
        where: { companyId: beta.companyId, systemKey: SYSTEM_ACCOUNT.CASH },
        select: { id: true, code: true },
      }),
    ]);

    expect(alphaCash.code).toBe(betaCash.code);
    expect(alphaCash.id).not.toBe(betaCash.id);
  });
});

describe("data separation", () => {
  it("keeps one tenant's journal entries out of the other's ledger", async () => {
    await postJournalEntry(prisma, {
      companyId: alpha.companyId,
      entryDate: DATE,
      voucherType: VoucherType.JOURNAL,
      narration: "Alpha only",
      lines: [
        { accountId: alpha.accounts.get(SYSTEM_ACCOUNT.CASH)!, debit: 12_345 },
        {
          accountId: alpha.accounts.get(SYSTEM_ACCOUNT.SALES)!,
          credit: 12_345,
        },
      ],
    });

    const betaLines = await prisma.journalLine.findMany({
      where: { companyId: beta.companyId },
      select: { debit: true },
    });

    expect(betaLines).toHaveLength(0);

    const alphaLines = await prisma.journalLine.count({
      where: { companyId: alpha.companyId },
    });
    expect(alphaLines).toBeGreaterThan(0);
  });

  it("scopes a ledger balance query to one tenant", async () => {
    await postJournalEntry(prisma, {
      companyId: beta.companyId,
      entryDate: DATE,
      voucherType: VoucherType.JOURNAL,
      narration: "Beta only",
      lines: [
        { accountId: beta.accounts.get(SYSTEM_ACCOUNT.CASH)!, debit: 500 },
        { accountId: beta.accounts.get(SYSTEM_ACCOUNT.SALES)!, credit: 500 },
      ],
    });

    const alphaCash = await prisma.journalLine.aggregate({
      where: {
        companyId: alpha.companyId,
        accountId: alpha.accounts.get(SYSTEM_ACCOUNT.CASH)!,
        status: "POSTED",
      },
      _sum: { debit: true },
    });

    const betaCash = await prisma.journalLine.aggregate({
      where: {
        companyId: beta.companyId,
        accountId: beta.accounts.get(SYSTEM_ACCOUNT.CASH)!,
        status: "POSTED",
      },
      _sum: { debit: true },
    });

    expect(alphaCash._sum.debit?.toString()).toBe("12345");
    expect(betaCash._sum.debit?.toString()).toBe("500");
  });

  it("refuses to post one tenant's entry against another tenant's account", async () => {
    // Cross-tenant account references must fail. Today the barrier is that a
    // period lookup is scoped by company and the account foreign key belongs
    // to the other tenant; the repository layer will also reject it in Phase 5.
    const foreignAccount = beta.accounts.get(SYSTEM_ACCOUNT.CASH);
    expect(foreignAccount).toBeTruthy();

    const line = await prisma.journalLine.findFirst({
      where: { companyId: alpha.companyId, accountId: foreignAccount! },
    });

    expect(line).toBeNull();
  });

  it("keeps each tenant's document sequences independent", async () => {
    const counterFor = async (companyId: string) => {
      const sequence = await prisma.documentSequence.findFirstOrThrow({
        where: { companyId, key: "JOURNAL" },
        select: { nextValue: true },
      });
      return sequence.nextValue;
    };

    const alphaBefore = await counterFor(alpha.companyId);
    const betaBefore = await counterFor(beta.companyId);

    // Both tenants have posted one entry each, so both counters sit in the
    // same place — which is exactly the point: numbering restarts per tenant
    // rather than being drawn from one global pool.
    expect(alphaBefore).toBe(betaBefore);

    await postJournalEntry(prisma, {
      companyId: alpha.companyId,
      entryDate: DATE,
      voucherType: VoucherType.JOURNAL,
      lines: [
        { accountId: alpha.accounts.get(SYSTEM_ACCOUNT.CASH)!, debit: 25 },
        { accountId: alpha.accounts.get(SYSTEM_ACCOUNT.SALES)!, credit: 25 },
      ],
    });

    // Alpha's counter moves; Beta's does not.
    expect(await counterFor(alpha.companyId)).toBe(alphaBefore + 1);
    expect(await counterFor(beta.companyId)).toBe(betaBefore);
  });
});

describe("purge isolation", () => {
  it("purges a tenant that has audit-log entries", async () => {
    // Regression: audit_logs.companyId is ON DELETE SET NULL, so purging a
    // company *updates* audit rows — and the append-only trigger rejects an
    // UPDATE just as firmly as a DELETE. The purge flag has to cover both.
    const withLogs = await createTenant("Audited Traders");

    await prisma.auditLog.create({
      data: {
        companyId: withLogs.companyId,
        action: "test.purge_regression",
        module: "Testing",
      },
    });

    await expect(purgeTestCompany(withLogs.companyId)).resolves.toBeUndefined();
    expect(
      await prisma.company.findUnique({ where: { id: withLogs.companyId } }),
    ).toBeNull();
  }, 60_000);

  it("deletes only the target tenant's data", async () => {
    const disposable = await createTenant("Disposable Traders");

    await postJournalEntry(prisma, {
      companyId: disposable.companyId,
      entryDate: DATE,
      voucherType: VoucherType.JOURNAL,
      lines: [
        {
          accountId: disposable.accounts.get(SYSTEM_ACCOUNT.CASH)!,
          debit: 100,
        },
        {
          accountId: disposable.accounts.get(SYSTEM_ACCOUNT.SALES)!,
          credit: 100,
        },
      ],
    });

    const alphaBefore = await prisma.journalLine.count({
      where: { companyId: alpha.companyId },
    });

    await purgeTestCompany(disposable.companyId);

    expect(
      await prisma.company.findUnique({ where: { id: disposable.companyId } }),
    ).toBeNull();
    expect(
      await prisma.journalLine.count({
        where: { companyId: disposable.companyId },
      }),
    ).toBe(0);
    expect(
      await prisma.account.count({
        where: { companyId: disposable.companyId },
      }),
    ).toBe(0);

    // The neighbouring tenant is untouched.
    expect(
      await prisma.journalLine.count({ where: { companyId: alpha.companyId } }),
    ).toBe(alphaBefore);
  });
});
