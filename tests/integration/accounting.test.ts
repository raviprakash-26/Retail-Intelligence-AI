import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { AccountInput } from "@/lib/validation/accounts";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale, voidSale } from "@/server/sales/sale-service";
import { createPayment } from "@/server/settlements/settlement-service";
import { createManualEntry } from "@/server/accounting/journal-service";
import {
  assignableGroups,
  createAccount,
  getChartOfAccounts,
  setAccountActive,
  updateAccount,
  AccountError,
} from "@/server/accounting/account-service";
import {
  accountBalances,
  accountingEquation,
  listAccountMeta,
  totalByType,
} from "@/server/accounting/balances";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The accounting engine.
 *
 * Two things are under test. First, that the balance engine returns what the
 * ledger actually says — including after a void, where a naive implementation
 * that filtered by document status rather than letting the reversal cancel the
 * original would quietly disagree with the journal.
 *
 * Second, that the chart can be shaped without the engine losing its footing: a
 * retailer may add and retire accounts, but nothing they can do should leave a
 * posting rule with nowhere to post.
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
      businessName: "Accounting Test Mart",
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

type Fixture = {
  companyId: string;
  userId: string;
  actorEmail: string;
};

async function createCompany(): Promise<Fixture> {
  const email = `acct-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };
}

function accountInput(
  groupId: string,
  overrides: Partial<AccountInput> = {},
): AccountInput {
  return {
    code: "6113",
    name: "Cold storage hire",
    groupId,
    type: "EXPENSE",
    subType: "INDIRECT_EXPENSE",
    description: "",
    ...overrides,
  };
}

/** A credit sale, so several accounts move at once. */
async function tradeOnce(fixture: Fixture) {
  const taxonomy = await getProductTaxonomy(fixture.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

  const product = await createProduct({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    input: {
      sku: "WIDGET",
      name: "Widget",
      description: "",
      barcode: "",
      hsnCode: "1905",
      categoryId: "",
      unitId: unit.id,
      taxRateId: gst18.id,
      purchasePrice: 60,
      sellingPrice: 100,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 100,
      openingRate: 60,
      minStockLevel: 0,
    } satisfies ProductInput,
  });

  const customer = await createParty({
    companyId: fixture.companyId,
    kind: "CUSTOMER",
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    input: {
      name: "Sharma Provision Store",
      phone: "",
      email: "",
      gstin: "",
      pan: "",
      addressLine1: "",
      city: "",
      stateCode: "",
      pincode: "",
      creditDays: 30,
      creditLimit: 100000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  const sale = await createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: customer.id,
      invoiceDate: new Date().toISOString().slice(0, 10),
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: product.id,
          description: "",
          quantity: 10,
          rate: 100,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });

  return { sale, product, customer };
}

const balanceOf = (
  balances: Awaited<ReturnType<typeof accountBalances>>,
  systemKey: string,
) => balances.find((entry) => entry.systemKey === systemKey);

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

describe("the balance engine", () => {
  it("reports every account of a company and nobody else's", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();

    const mine = await listAccountMeta(alpha.companyId);
    const theirs = await listAccountMeta(beta.companyId);

    expect(mine.length).toBeGreaterThan(30);
    expect(mine.length).toBe(theirs.length);
    // Same chart, different rows: no id appears in both.
    const ids = new Set(mine.map((entry) => entry.id));
    expect(theirs.some((entry) => ids.has(entry.id))).toBe(false);
  });

  it("balances a freshly provisioned company at zero", async () => {
    const fixture = await createCompany();
    const equation = accountingEquation(
      await accountBalances({ companyId: fixture.companyId }),
    );

    expect(equation.balanced).toBe(true);
    expect(equation.assets.toFixed(2)).toBe("0.00");
    expect(equation.profit.toFixed(2)).toBe("0.00");
  });

  it("keeps the accounting equation true after trading", async () => {
    const fixture = await createCompany();
    await tradeOnce(fixture);

    const balances = await accountBalances({ companyId: fixture.companyId });
    const equation = accountingEquation(balances);

    expect(equation.balanced).toBe(true);
    expect(equation.difference.toFixed(2)).toBe("0.00");

    // ₹1,000 of goods at 18% on credit: receivables ₹1,180, sales ₹1,000,
    // output tax ₹90 + ₹90, cost of sales ₹600 out of stock.
    expect(
      balanceOf(balances, SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE)?.balance.toFixed(
        2,
      ),
    ).toBe("1180.00");
    expect(balanceOf(balances, SYSTEM_ACCOUNT.SALES)?.balance.toFixed(2)).toBe(
      "1000.00",
    );
    expect(
      balanceOf(balances, SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD)?.balance.toFixed(
        2,
      ),
    ).toBe("600.00");
    // Income less expenses, with opening stock charged out as it was sold.
    expect(equation.profit.toFixed(2)).toBe("400.00");
  });

  it("puts income and liabilities the right way up", async () => {
    const fixture = await createCompany();
    await tradeOnce(fixture);

    const totals = totalByType(
      await accountBalances({ companyId: fixture.companyId }),
    );

    // Credit-nature totals are positive when they sit on their natural side —
    // reading them off the debit column would make income negative and every
    // figure downstream wrong.
    expect(Number(totals.INCOME)).toBeGreaterThan(0);
    expect(Number(totals.LIABILITY)).toBeGreaterThan(0);
    expect(Number(totals.ASSET)).toBeGreaterThan(0);
  });

  it("treats drawings as a reduction of capital, not an addition to it", async () => {
    // Drawings sit inside capital but carry a debit balance. Summed in their
    // own direction they would *add* to the owner's stake, and the equation
    // would be out by twice the amount on every sole proprietorship that has
    // ever taken money out of the till.
    const fixture = await createCompany();
    const before = totalByType(
      await accountBalances({ companyId: fixture.companyId }),
    );

    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "DRAWINGS",
        partyId: "",
        date: new Date().toISOString().slice(0, 10),
        paymentMode: "CASH",
        amount: 15_000,
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    const balances = await accountBalances({ companyId: fixture.companyId });
    const after = totalByType(balances);

    expect(Number(after.EQUITY) - Number(before.EQUITY)).toBeCloseTo(
      -15_000,
      2,
    );
    expect(accountingEquation(balances).balanced).toBe(true);
  });

  it("treats accumulated depreciation as a reduction of assets", async () => {
    const fixture = await createCompany();
    const meta = await listAccountMeta(fixture.companyId);
    const expense = meta.find(
      (entry) => entry.systemKey === SYSTEM_ACCOUNT.DEPRECIATION_EXPENSE,
    );
    const accumulated = meta.find(
      (entry) => entry.systemKey === SYSTEM_ACCOUNT.ACCUMULATED_DEPRECIATION,
    );

    await createManualEntry({
      companyId: fixture.companyId,
      branchId: null,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        entryDate: new Date().toISOString().slice(0, 10),
        voucherType: "DEPRECIATION",
        narration: "Depreciation for the year on the display fridge",
        referenceNo: "",
        lines: [
          {
            accountId: expense!.id,
            debit: 4000,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: accumulated!.id,
            debit: 0,
            credit: 4000,
            narration: "",
            partyId: "",
          },
        ],
      },
    });

    const balances = await accountBalances({ companyId: fixture.companyId });
    const totals = totalByType(balances);

    // A contra-asset: it reduces what the business owns.
    expect(Number(totals.ASSET)).toBeCloseTo(-4000, 2);
    expect(accountingEquation(balances).balanced).toBe(true);

    // On the chart it still reads as a positive credit balance, because that
    // is what somebody looking at the account expects to see.
    expect(
      balances
        .find(
          (entry) =>
            entry.systemKey === SYSTEM_ACCOUNT.ACCUMULATED_DEPRECIATION,
        )
        ?.balance.toFixed(2),
    ).toBe("4000.00");
  });

  it("nets a void away without excluding it by status", async () => {
    const fixture = await createCompany();
    const { sale } = await tradeOnce(fixture);

    await voidSale({
      companyId: fixture.companyId,
      saleId: sale.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Entered against the wrong customer",
    });

    const balances = await accountBalances({ companyId: fixture.companyId });
    expect(
      balanceOf(balances, SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE)?.balance.toFixed(
        2,
      ),
    ).toBe("0.00");
    expect(balanceOf(balances, SYSTEM_ACCOUNT.SALES)?.balance.toFixed(2)).toBe(
      "0.00",
    );
    expect(accountingEquation(balances).balanced).toBe(true);

    // Both entries are still there: the ledger shows it happened and was undone.
    const entries = await prisma.journalEntry.count({
      where: { companyId: fixture.companyId, sourceId: sale.id },
    });
    expect(entries).toBe(2);
  });

  it("splits a window into what was carried in and what moved", async () => {
    const fixture = await createCompany();
    await tradeOnce(fixture);

    const tomorrow = new Date(Date.now() + 86_400_000);
    const balances = await accountBalances({
      companyId: fixture.companyId,
      from: tomorrow,
    });

    const sales = balanceOf(balances, SYSTEM_ACCOUNT.SALES);
    // Everything happened before the window opened, so it is all opening.
    expect(sales?.periodDebit.toFixed(2)).toBe("0.00");
    expect(sales?.periodCredit.toFixed(2)).toBe("0.00");
    expect(sales?.openingCredit.toFixed(2)).toBe("1000.00");
    expect(sales?.closingCredit.toFixed(2)).toBe("1000.00");
  });

  it("excludes what happened after the window closes", async () => {
    const fixture = await createCompany();
    await tradeOnce(fixture);

    const yesterday = new Date(Date.now() - 86_400_000);
    const balances = await accountBalances({
      companyId: fixture.companyId,
      to: yesterday,
    });

    expect(balanceOf(balances, SYSTEM_ACCOUNT.SALES)?.balance.toFixed(2)).toBe(
      "0.00",
    );
  });
});

describe("shaping the chart of accounts", () => {
  it("returns the chart as a tree with balances on it", async () => {
    const fixture = await createCompany();
    await tradeOnce(fixture);

    const chart = await getChartOfAccounts({ companyId: fixture.companyId });

    expect(chart.tree.length).toBeGreaterThan(0);
    expect(chart.counts.custom).toBe(0);
    expect(chart.counts.total).toBe(chart.accounts.length);

    const sales = chart.accounts.find(
      (account) => account.systemKey === SYSTEM_ACCOUNT.SALES,
    );
    expect(sales?.balance).toBe(toStorageString(1000));
    expect(sales?.isSystem).toBe(true);
  });

  it("adds an account a retailer needs", async () => {
    const fixture = await createCompany();
    const groups = await assignableGroups({
      companyId: fixture.companyId,
      type: "EXPENSE",
    });
    const admin = groups.find((group) => group.code === "6100");
    expect(admin).toBeDefined();

    const created = await createAccount({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: accountInput(admin!.id),
    });

    const chart = await getChartOfAccounts({ companyId: fixture.companyId });
    const found = chart.accounts.find((account) => account.id === created.id);

    expect(found?.code).toBe("6113");
    expect(found?.isSystem).toBe(false);
    expect(found?.nature).toBe("DEBIT");
    expect(found?.section).toBe("PROFIT_AND_LOSS");
    expect(chart.counts.custom).toBe(1);
  });

  it("puts a direct cost above the gross-profit line", async () => {
    const fixture = await createCompany();
    const groups = await assignableGroups({
      companyId: fixture.companyId,
      type: "EXPENSE",
    });
    const direct = groups.find((group) => group.code === "5000");

    const created = await createAccount({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: accountInput(direct!.id, {
        code: "5007",
        name: "Mandi fees",
        subType: "DIRECT_EXPENSE",
      }),
    });

    const chart = await getChartOfAccounts({ companyId: fixture.companyId });
    expect(
      chart.accounts.find((account) => account.id === created.id)?.section,
    ).toBe("TRADING");
  });

  it("refuses a code already in use", async () => {
    const fixture = await createCompany();
    const groups = await assignableGroups({
      companyId: fixture.companyId,
      type: "EXPENSE",
    });

    await expect(
      createAccount({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        // 6102 is Rent, seeded with every company.
        input: accountInput(groups[0]!.id, { code: "6102" }),
      }),
    ).rejects.toThrow(/already used by/i);
  });

  it("refuses to file an account under a group of another type", async () => {
    const fixture = await createCompany();
    const assetGroups = await assignableGroups({
      companyId: fixture.companyId,
      type: "ASSET",
    });

    await expect(
      createAccount({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: accountInput(assetGroups[0]!.id, { type: "EXPENSE" }),
      }),
    ).rejects.toThrow(/holds asset accounts/i);
  });

  it("refuses a sub-type that does not belong to the type", async () => {
    const fixture = await createCompany();
    const groups = await assignableGroups({
      companyId: fixture.companyId,
      type: "EXPENSE",
    });

    await expect(
      createAccount({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: accountInput(groups[0]!.id, { subType: "SALES" }),
      }),
    ).rejects.toThrow(AccountError);
  });

  it("will not put an account in another company's group", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    const theirGroups = await assignableGroups({
      companyId: beta.companyId,
      type: "EXPENSE",
    });

    await expect(
      createAccount({
        companyId: alpha.companyId,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        input: accountInput(theirGroups[0]!.id),
      }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("renames a system account without breaking what posts to it", async () => {
    const fixture = await createCompany();
    const meta = await listAccountMeta(fixture.companyId);
    const sales = meta.find(
      (account) => account.systemKey === SYSTEM_ACCOUNT.SALES,
    );

    await updateAccount({
      companyId: fixture.companyId,
      accountId: sales!.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: { name: "Counter Takings", description: "" },
    });

    // The rename sticks, the key does not move, and a sale still posts to it.
    await tradeOnce(fixture);
    const balances = await accountBalances({ companyId: fixture.companyId });
    const renamed = balanceOf(balances, SYSTEM_ACCOUNT.SALES);

    expect(renamed?.name).toBe("Counter Takings");
    expect(renamed?.balance.toFixed(2)).toBe("1000.00");
  });

  it("refuses to retire an account the engine posts to", async () => {
    const fixture = await createCompany();
    const meta = await listAccountMeta(fixture.companyId);
    const cash = meta.find(
      (account) => account.systemKey === SYSTEM_ACCOUNT.CASH,
    );

    await expect(
      setAccountActive({
        companyId: fixture.companyId,
        accountId: cash!.id,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        isActive: false,
      }),
    ).rejects.toThrow(/has to stay available/i);
  });

  it("retires an unused account and brings it back", async () => {
    const fixture = await createCompany();
    const groups = await assignableGroups({
      companyId: fixture.companyId,
      type: "EXPENSE",
    });
    const created = await createAccount({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: accountInput(groups[0]!.id),
    });

    await setAccountActive({
      companyId: fixture.companyId,
      accountId: created.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      isActive: false,
    });

    const hidden = await getChartOfAccounts({ companyId: fixture.companyId });
    expect(hidden.accounts.some((account) => account.id === created.id)).toBe(
      false,
    );
    expect(hidden.counts.inactive).toBe(1);

    const shown = await getChartOfAccounts({
      companyId: fixture.companyId,
      includeInactive: true,
    });
    expect(
      shown.accounts.find((account) => account.id === created.id)?.isActive,
    ).toBe(false);

    await setAccountActive({
      companyId: fixture.companyId,
      accountId: created.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      isActive: true,
    });
    const back = await getChartOfAccounts({ companyId: fixture.companyId });
    expect(back.accounts.some((account) => account.id === created.id)).toBe(
      true,
    );
  });

  it("will not touch another company's account", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    const theirs = (await listAccountMeta(beta.companyId))[0];

    await expect(
      updateAccount({
        companyId: alpha.companyId,
        accountId: theirs!.id,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        input: { name: "Renamed by the wrong company", description: "" },
      }),
    ).rejects.toThrow(/could not be found/i);

    await expect(
      setAccountActive({
        companyId: alpha.companyId,
        accountId: theirs!.id,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        isActive: false,
      }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("writes an audit trail for every change to the chart", async () => {
    const fixture = await createCompany();
    const groups = await assignableGroups({
      companyId: fixture.companyId,
      type: "EXPENSE",
    });
    const created = await createAccount({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: accountInput(groups[0]!.id),
    });
    await updateAccount({
      companyId: fixture.companyId,
      accountId: created.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: { name: "Cold storage", description: "" },
    });

    const logs = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyId, entityId: created.id },
      select: { action: true },
      orderBy: { createdAt: "asc" },
    });
    expect(logs.map((log) => log.action)).toEqual([
      "account.created",
      "account.updated",
    ]);
  });
});
