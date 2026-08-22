import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { createPayment } from "@/server/settlements/settlement-service";
import { listAccountMeta } from "@/server/accounting/balances";
import { createManualEntry } from "@/server/accounting/journal-service";
import { createBranch } from "@/server/company/branch-service";
import {
  assertLedgerBalances,
  differenceBetween,
  getTrialBalance,
  toCsvRows,
  TrialBalanceUnbalancedError,
} from "@/server/accounting/trial-balance-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

const prisma = testDb();

/**
 * The trial balance.
 *
 * It is the gate the financial statements sit behind, so the two things worth
 * proving are that its totals agree with the ledger they came from, and that it
 * reports balances where they actually sit rather than where an account's
 * declared nature says they ought to.
 */

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
      businessName: "Trial Balance Test Mart",
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
  productId: string;
  customerId: string;
};

/** Registered and nothing else: no product, so not even an opening entry. */
async function createBareCompany(): Promise<{
  companyId: string;
  userId: string;
  actorEmail: string;
}> {
  const email = `tb0-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };
}

async function createCompany(): Promise<Fixture> {
  const email = `tb-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);

  const base = {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };

  const taxonomy = await getProductTaxonomy(result.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const gst0 = taxonomy.taxRates.find((entry) => entry.code === "GST0");
  if (!unit || !gst0) throw new Error("Provisioning is incomplete");

  const product = await createProduct({
    ...base,
    input: {
      sku: "WIDGET",
      name: "Widget",
      description: "",
      barcode: "",
      hsnCode: "1905",
      categoryId: "",
      unitId: unit.id,
      taxRateId: gst0.id,
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
    ...base,
    kind: "CUSTOMER",
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
      creditLimit: 500000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  return { ...base, productId: product.id, customerId: customer.id };
}

async function sell(
  fixture: Fixture,
  quantity: number,
  date = new Date().toISOString().slice(0, 10),
) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: date,
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity,
          rate: 100,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
}

const allRows = (trial: Awaited<ReturnType<typeof getTrialBalance>>) =>
  trial.sections.flatMap((section) => section.rows);

const rowFor = (
  trial: Awaited<ReturnType<typeof getTrialBalance>>,
  code: string,
) => allRows(trial).find((row) => row.code === code);

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

describe("the trial balance", () => {
  it("balances a company that has traded", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4); // ₹400 receivable, ₹400 sales, ₹240 cost

    const trial = await getTrialBalance({ companyId: fixture.companyId });

    expect(trial.balanced).toBe(true);
    expect(trial.difference).toBe(toStorageString(0));
    expect(trial.totalDebit).toBe(trial.totalCredit);
    expect(Number(trial.totalDebit)).toBeGreaterThan(0);
  });

  it("balances a company that has done nothing at all", async () => {
    const fixture = await createBareCompany();
    const trial = await getTrialBalance({ companyId: fixture.companyId });

    expect(trial.balanced).toBe(true);
    expect(trial.totalDebit).toBe(toStorageString(0));
    expect(trial.sections).toEqual([]);
  });

  it("puts each account in the column its balance is actually on", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4);

    const trial = await getTrialBalance({ companyId: fixture.companyId });

    const receivables = rowFor(trial, "1121");
    expect(receivables?.closingDebit).toBe(toStorageString(400));
    expect(receivables?.closingCredit).toBe(toStorageString(0));

    const sales = rowFor(trial, "4101");
    expect(sales?.closingCredit).toBe(toStorageString(400));
    expect(sales?.closingDebit).toBe(toStorageString(0));

    const cost = rowFor(trial, "5003");
    expect(cost?.closingDebit).toBe(toStorageString(240));
  });

  it("reports a control account with an unexpected balance where it sits", async () => {
    // Paying a supplier who is owed nothing leaves payables with a debit
    // balance — an advance. Forcing it to the credit column because payables
    // are "supposed to" be credits would hide the oddity the report exists for.
    const fixture = await createCompany();
    const supplier = await createParty({
      companyId: fixture.companyId,
      kind: "SUPPLIER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        name: "Metro Wholesale",
        phone: "",
        email: "",
        gstin: "",
        pan: "",
        addressLine1: "",
        city: "",
        stateCode: "29",
        pincode: "",
        creditDays: 30,
        openingBalance: 0,
        openingNature: "CREDIT",
        notes: "",
      },
    });

    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "SUPPLIER",
        partyId: supplier.id,
        date: new Date().toISOString().slice(0, 10),
        paymentMode: "CASH",
        amount: 5000,
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    const trial = await getTrialBalance({ companyId: fixture.companyId });
    const payables = rowFor(trial, "2111");

    expect(payables?.closingDebit).toBe(toStorageString(5000));
    expect(payables?.closingCredit).toBe(toStorageString(0));
    expect(trial.balanced).toBe(true);
  });

  it("splits a window into what was carried in and what moved", async () => {
    const fixture = await createCompany();
    await sell(fixture, 3, "2026-05-10"); // before the window
    await sell(fixture, 2, "2026-06-15"); // inside it

    const trial = await getTrialBalance({
      companyId: fixture.companyId,
      from: "2026-06-01",
      to: "2026-06-30",
    });

    expect(trial.hasWindow).toBe(true);
    const receivables = rowFor(trial, "1121");
    expect(receivables?.openingDebit).toBe(toStorageString(300));
    expect(receivables?.periodDebit).toBe(toStorageString(200));
    expect(receivables?.closingDebit).toBe(toStorageString(500));
    expect(trial.balanced).toBe(true);
  });

  it("keeps an account that moved in the period but nets to nothing", async () => {
    // Cash out and back in during the period is a fact about the period. An
    // account dropped for having a nil balance would make the movement columns
    // stop adding up to the totals beneath them.
    const fixture = await createCompany();
    const meta = await listAccountMeta(fixture.companyId);
    const cash = meta.find((entry) => entry.systemKey === SYSTEM_ACCOUNT.CASH);
    const bank = meta.find((entry) => entry.systemKey === SYSTEM_ACCOUNT.BANK);
    const today = new Date().toISOString().slice(0, 10);

    const moves = [
      { debit: bank!.id, credit: cash!.id },
      { debit: cash!.id, credit: bank!.id },
    ];
    for (const { debit, credit } of moves) {
      await createManualEntry({
        companyId: fixture.companyId,
        branchId: null,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: {
          entryDate: today,
          voucherType: "CONTRA",
          narration: "Moved between the till and the bank",
          referenceNo: "",
          lines: [
            {
              accountId: debit,
              debit: 1000,
              credit: 0,
              narration: "",
              partyId: "",
            },
            {
              accountId: credit,
              debit: 0,
              credit: 1000,
              narration: "",
              partyId: "",
            },
          ],
        },
      });
    }

    const windowed = await getTrialBalance({
      companyId: fixture.companyId,
      from: "2020-01-01",
    });
    const cashRow = windowed.sections
      .flatMap((section) => section.rows)
      .find((row) => row.accountId === cash!.id);

    expect(cashRow).toBeDefined();
    expect(cashRow?.periodDebit).toBe(toStorageString(1000));
    expect(cashRow?.periodCredit).toBe(toStorageString(1000));
    expect(cashRow?.closingDebit).toBe(toStorageString(0));

    // Without a window there is no movement to explain, so it is dropped.
    const plain = await getTrialBalance({ companyId: fixture.companyId });
    expect(
      plain.sections
        .flatMap((section) => section.rows)
        .some((row) => row.accountId === cash!.id),
    ).toBe(false);
  });

  it("omits untouched accounts but can be asked for them", async () => {
    const fixture = await createCompany();
    await sell(fixture, 1);

    const lean = await getTrialBalance({ companyId: fixture.companyId });
    const full = await getTrialBalance({
      companyId: fixture.companyId,
      includeEmpty: true,
    });

    expect(lean.omitted).toBeGreaterThan(0);
    expect(full.shown).toBe(lean.shown + lean.omitted);
    expect(full.omitted).toBe(0);
    // Adding the empty rows changes nothing about the totals.
    expect(full.totalDebit).toBe(lean.totalDebit);
    expect(full.balanced).toBe(true);
  });

  it("groups accounts by type, in the order they are read", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4);

    const trial = await getTrialBalance({ companyId: fixture.companyId });
    const order = trial.sections.map((section) => section.type);

    expect(order).toEqual(
      ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"].filter((type) =>
        order.includes(type as never),
      ),
    );
    for (const section of trial.sections) {
      expect(section.rows.length).toBeGreaterThan(0);
      expect(section.label).toBeTruthy();
    }
  });

  it("subtotals each section to the printed rows", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4);

    const trial = await getTrialBalance({ companyId: fixture.companyId });
    for (const section of trial.sections) {
      const debit = section.rows.reduce(
        (sum, row) => sum + Number(row.closingDebit),
        0,
      );
      const credit = section.rows.reduce(
        (sum, row) => sum + Number(row.closingCredit),
        0,
      );
      expect(Number(section.subtotalDebit)).toBeCloseTo(debit, 2);
      expect(Number(section.subtotalCredit)).toBeCloseTo(credit, 2);
    }
  });

  it("totals the sections to the grand total", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4);

    const trial = await getTrialBalance({ companyId: fixture.companyId });
    const debit = trial.sections.reduce(
      (sum, section) => sum + Number(section.subtotalDebit),
      0,
    );
    const credit = trial.sections.reduce(
      (sum, section) => sum + Number(section.subtotalCredit),
      0,
    );

    expect(debit).toBeCloseTo(Number(trial.totalDebit), 2);
    expect(credit).toBeCloseTo(Number(trial.totalCredit), 2);
  });

  it("excludes what happened after the as-at date", async () => {
    const fixture = await createCompany();
    await sell(fixture, 3, "2026-06-15");
    await sell(fixture, 9, "2026-07-15");

    const trial = await getTrialBalance({
      companyId: fixture.companyId,
      to: "2026-06-30",
    });

    expect(rowFor(trial, "1121")?.closingDebit).toBe(toStorageString(300));
    expect(trial.balanced).toBe(true);
  });

  it("shows nobody else's accounts", async () => {
    const alpha = await createBareCompany();
    const beta = await createCompany();
    await sell(beta, 7);

    const trial = await getTrialBalance({ companyId: alpha.companyId });
    expect(trial.totalDebit).toBe(toStorageString(0));
    expect(trial.sections).toEqual([]);
  });
});

/**
 * One shutter at a time.
 *
 * A retailer with two shops wants to know which one is paying for itself, and
 * the ledger already holds the answer: a member is assigned to a branch and
 * every entry they post is stamped with it. The reports take a `branchId` and
 * hand it down to the balance engine.
 *
 * The engine filtered on it through a relation named `entry`. The relation on a
 * journal line is `journalEntry`, so Prisma refused the query and asking for one
 * branch's figures raised a validation error instead of answering. Every
 * branch-scoped read — trial balance, profit and loss, balance sheet — went the
 * same way.
 *
 * It type-checked because the filter is assembled inside a conditional spread,
 * and a key in that position is not excess-property checked: a wrong relation
 * name compiles exactly like a right one. Only running it tells them apart, and
 * nothing ran it. Hence these.
 */
describe("scoped to one branch", () => {
  type TwoBranches = {
    companyId: string;
    userId: string;
    actorEmail: string;
    mainId: string;
    secondId: string;
    rentCode: string;
    accruedCode: string;
  };

  /** A company with a second shop, and the codes its rent lands on. */
  async function twoBranches(): Promise<TwoBranches> {
    const fixture = await createBareCompany();

    const main = await prisma.branch.findFirstOrThrow({
      where: { companyId: fixture.companyId, isPrimary: true },
      select: { id: true },
    });

    const second = await createBranch({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        code: "BLR2",
        name: "Jayanagar",
        addressLine1: "",
        city: "",
        stateCode: "",
        pincode: "",
        phone: "",
      },
    });

    const meta = await listAccountMeta(fixture.companyId);
    const rent = meta.find(
      (entry) => entry.systemKey === SYSTEM_ACCOUNT.RENT_EXPENSE,
    );
    const accrued = meta.find(
      (entry) => entry.systemKey === SYSTEM_ACCOUNT.ACCRUED_EXPENSES,
    );
    if (!rent || !accrued) throw new Error("Provisioning is incomplete");

    return {
      ...fixture,
      mainId: main.id,
      secondId: second.id,
      rentCode: rent.code,
      accruedCode: accrued.code,
    };
  }

  /** Rent owed for a month, charged to the shop that occupies the premises. */
  async function accrueRent(
    fixture: TwoBranches,
    branchId: string,
    amount: number,
    date: string,
  ): Promise<void> {
    const meta = await listAccountMeta(fixture.companyId);
    const rent = meta.find((entry) => entry.code === fixture.rentCode)!;
    const accrued = meta.find((entry) => entry.code === fixture.accruedCode)!;

    await createManualEntry({
      companyId: fixture.companyId,
      branchId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        entryDate: date,
        voucherType: "JOURNAL",
        narration: "Shop rent owed for the month",
        referenceNo: "",
        lines: [
          {
            accountId: rent.id,
            debit: amount,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: accrued.id,
            debit: 0,
            credit: amount,
            narration: "",
            partyId: "",
          },
        ],
      },
    });
  }

  it("counts only what was posted at that branch", async () => {
    const fixture = await twoBranches();
    await accrueRent(fixture, fixture.mainId, 30000, "2026-06-05");
    await accrueRent(fixture, fixture.secondId, 18000, "2026-06-05");

    const main = await getTrialBalance({
      companyId: fixture.companyId,
      branchId: fixture.mainId,
    });
    const second = await getTrialBalance({
      companyId: fixture.companyId,
      branchId: fixture.secondId,
    });

    expect(rowFor(main, fixture.rentCode)?.closingDebit).toBe(
      toStorageString(30000),
    );
    expect(rowFor(second, fixture.rentCode)?.closingDebit).toBe(
      toStorageString(18000),
    );

    // Each still balances on its own. A filter that reached the expense but not
    // the liability would leave a branch's columns lopsided.
    expect(main.balanced).toBe(true);
    expect(second.balanced).toBe(true);
    expect(rowFor(main, fixture.accruedCode)?.closingCredit).toBe(
      toStorageString(30000),
    );
  });

  it("adds the branches up to the business", async () => {
    // The invariant that catches a filter which is merely narrow rather than
    // wrong: whatever the branches say separately has to come to what the
    // company says together, because every entry sits at exactly one branch.
    const fixture = await twoBranches();
    await accrueRent(fixture, fixture.mainId, 30000, "2026-06-05");
    await accrueRent(fixture, fixture.secondId, 18000, "2026-06-05");

    const [whole, main, second] = await Promise.all([
      getTrialBalance({ companyId: fixture.companyId }),
      getTrialBalance({
        companyId: fixture.companyId,
        branchId: fixture.mainId,
      }),
      getTrialBalance({
        companyId: fixture.companyId,
        branchId: fixture.secondId,
      }),
    ]);

    expect(Number(whole.totalDebit)).toBeCloseTo(
      Number(main.totalDebit) + Number(second.totalDebit),
      2,
    );
    expect(rowFor(whole, fixture.rentCode)?.closingDebit).toBe(
      toStorageString(48000),
    );
  });

  it("carries a branch's earlier entries into its opening column", async () => {
    // The engine reads twice — everything before the window, then the window
    // itself — and hands the branch to both. A fix applied to one read only
    // would pass the cases above, where there is nothing before the window,
    // and quietly report a branch as though it opened at nil.
    const fixture = await twoBranches();
    await accrueRent(fixture, fixture.secondId, 18000, "2026-05-05");
    await accrueRent(fixture, fixture.secondId, 18000, "2026-06-05");
    await accrueRent(fixture, fixture.mainId, 30000, "2026-05-05");

    const second = await getTrialBalance({
      companyId: fixture.companyId,
      branchId: fixture.secondId,
      from: "2026-06-01",
      to: "2026-06-30",
    });

    const rent = rowFor(second, fixture.rentCode);
    expect(rent?.openingDebit).toBe(toStorageString(18000));
    expect(rent?.periodDebit).toBe(toStorageString(18000));
    expect(rent?.closingDebit).toBe(toStorageString(36000));

    // The other shop's rent belongs to neither column.
    const main = await getTrialBalance({
      companyId: fixture.companyId,
      branchId: fixture.mainId,
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(rowFor(main, fixture.rentCode)?.openingDebit).toBe(
      toStorageString(30000),
    );
    expect(rowFor(main, fixture.rentCode)?.periodDebit).toBe(
      toStorageString(0),
    );
  });
});

describe("the gate the statements sit behind", () => {
  it("passes for a ledger that balances", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4);

    await expect(
      assertLedgerBalances({ companyId: fixture.companyId }),
    ).resolves.toBeUndefined();
  });

  it("names the difference when it refuses", () => {
    const error = new TrialBalanceUnbalancedError("120.0000");
    expect(error.message).toMatch(/differ by 120\.0000/);
    expect(error.message).toMatch(/No statement can be produced/);
  });
});

describe("the export", () => {
  it("produces one row per printed account, in the printed order", async () => {
    const fixture = await createCompany();
    await sell(fixture, 4);

    const trial = await getTrialBalance({ companyId: fixture.companyId });
    const rows = toCsvRows(trial);

    expect(rows).toHaveLength(allRows(trial).length);
    expect(rows[0]?.Type).toBe(trial.sections[0]?.label ?? "");
    expect(rows[0]?.Code).toBe(trial.sections[0]?.rows[0]?.code ?? "");
    // Without a window there are no opening or movement columns to export.
    expect(rows[0]).not.toHaveProperty("Opening Dr");
  });

  it("carries the opening and movement columns when there is a window", async () => {
    const fixture = await createCompany();
    await sell(fixture, 3, "2026-05-10");
    await sell(fixture, 2, "2026-06-15");

    const trial = await getTrialBalance({
      companyId: fixture.companyId,
      from: "2026-06-01",
      to: "2026-06-30",
    });
    const rows = toCsvRows(trial);

    expect(rows[0]).toHaveProperty("Opening Dr");
    expect(rows[0]).toHaveProperty("Period Cr");
  });
});

describe("describing a difference", () => {
  it("says which side is heavy", () => {
    expect(differenceBetween("500", "300")).toEqual({
      amount: toStorageString(200),
      side: "debit",
    });
    expect(differenceBetween("300", "500")).toEqual({
      amount: toStorageString(200),
      side: "credit",
    });
  });

  it("says neither when they agree", () => {
    expect(differenceBetween("500", "500")).toEqual({
      amount: toStorageString(0),
      side: "none",
    });
  });
});
