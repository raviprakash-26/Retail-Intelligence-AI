import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import { subtract, toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { SupplierInput } from "@/lib/validation/master-data";
import type { ExpenseInput } from "@/lib/validation/expenses";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import {
  createExpense,
  listExpenseCategories,
  listExpenses,
  voidExpense,
  ExpenseError,
} from "@/server/expenses/expense-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

type Registration = "REGULAR" | "COMPOSITION" | "UNREGISTERED";

function registrationInput(email: string, scheme: Registration): RegisterInput {
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
      businessName: "Expense Test Mart",
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: scheme,
      gstin: scheme === "UNREGISTERED" ? "" : "29AAAPR1234K1ZP",
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
  rentCategoryId: string;
  salaryCategoryId: string;
};

async function createCompany(
  scheme: Registration = "REGULAR",
): Promise<Fixture> {
  const email = `exp-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email, scheme));
  createdCompanies.push(result.companyId);

  const categories = await listExpenseCategories(result.companyId);
  const rent = categories.find((entry) => entry.name === "Rent");
  const salary = categories.find((entry) => entry.name === "Salary");
  if (!rent || !salary) throw new Error("Provisioning did not seed categories");

  return {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
    rentCategoryId: rent.id,
    salaryCategoryId: salary.id,
  };
}

function expenseInput(
  categoryId: string,
  overrides: Partial<ExpenseInput> = {},
): ExpenseInput {
  return {
    categoryId,
    expenseDate: new Date().toISOString().slice(0, 10),
    paymentMode: "CASH",
    supplierId: "",
    payeeName: "",
    amount: 10000,
    taxPercent: 0,
    amountIncludesTax: true,
    claimInputCredit: true,
    isCapitalExpenditure: false,
    assetName: "",
    assetUsefulLifeMonths: 60,
    referenceNo: "",
    notes: "",
    ...overrides,
  };
}

function supplierInput(overrides: Partial<SupplierInput> = {}): SupplierInput {
  return {
    name: "Landlord",
    phone: "",
    email: "",
    gstin: "29AABCA1234C1Z5",
    pan: "",
    addressLine1: "",
    city: "",
    stateCode: "29",
    pincode: "",
    creditDays: 0,
    openingBalance: 0,
    openingNature: "CREDIT",
    notes: "",
    ...overrides,
  };
}

async function accountBalance(
  companyId: string,
  systemKey: string,
): Promise<string> {
  const account = await prisma.account.findFirstOrThrow({
    where: { companyId, systemKey },
    select: { id: true },
  });
  const totals = await prisma.journalLine.aggregate({
    where: { companyId, accountId: account.id, status: "POSTED" },
    _sum: { debit: true, credit: true },
  });
  return toStorageString(
    subtract(totals._sum.debit ?? 0, totals._sum.credit ?? 0),
  );
}

async function assertTrialBalances(companyId: string): Promise<void> {
  const lines = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: { companyId, status: "POSTED" },
    _sum: { debit: true, credit: true },
  });
  const trial = trialBalanceIsBalanced(
    lines.map((line) => ({
      debit: line._sum.debit ?? 0,
      credit: line._sum.credit ?? 0,
    })),
  );
  expect(trial.difference.toString()).toBe("0");
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

describe("posting an expense", () => {
  it("charges the category's own account, not a catch-all", async () => {
    const fixture = await createCompany();

    await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, { amount: 25000 }),
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.RENT_EXPENSE),
    ).toBe(toStorageString(25000));
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(-25000),
    );
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
      ),
    ).toBe(toStorageString(0));

    await assertTrialBalances(fixture.companyId);
  });

  it("leaves an unpaid expense as a payable owed to the supplier", async () => {
    const fixture = await createCompany();
    const landlord = await createParty({
      companyId: fixture.companyId,
      kind: "SUPPLIER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: supplierInput(),
    });

    await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 25000,
        paymentMode: "CREDIT",
        supplierId: landlord.id,
      }),
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(-25000));
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(0),
    );

    // Attributed to the landlord so it can be chased and settled.
    const line = await prisma.journalLine.findFirst({
      where: {
        companyId: fixture.companyId,
        partyType: "SUPPLIER",
        partyId: landlord.id,
        credit: { gt: 0 },
      },
      select: { credit: true },
    });
    expect(toStorageString(line?.credit ?? 0)).toBe(toStorageString(25000));
  });

  it("keeps a free-text payee without inventing a supplier record", async () => {
    const fixture = await createCompany();
    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, { payeeName: "BESCOM" }),
    });

    const record = await prisma.expense.findUniqueOrThrow({
      where: { id: posted.id },
      select: { payeeName: true, partyId: true },
    });
    expect(record.payeeName).toBe("BESCOM");
    expect(record.partyId).toBeNull();
    expect(
      await prisma.supplier.count({ where: { companyId: fixture.companyId } }),
    ).toBe(0);
  });
});

describe("GST on an expense", () => {
  it("splits a tax-inclusive amount and holds the claimable part apart", async () => {
    const fixture = await createCompany();

    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 11800,
        taxPercent: 18,
        amountIncludesTax: true,
      }),
    });

    expect(posted.totalAmount).toBe(toStorageString(11800));
    expect(posted.itcEligible).toBe(true);

    // ₹11,800 paid is ₹10,000 of rent and ₹1,800 of recoverable tax.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.RENT_EXPENSE),
    ).toBe(toStorageString(10000));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(900));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_SGST),
    ).toBe(toStorageString(900));
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(-11800),
    );

    await assertTrialBalances(fixture.companyId);
  });

  it("adds tax on top when the amount is exclusive", async () => {
    const fixture = await createCompany();
    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 10000,
        taxPercent: 18,
        amountIncludesTax: false,
      }),
    });

    expect(posted.totalAmount).toBe(toStorageString(11800));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.RENT_EXPENSE),
    ).toBe(toStorageString(10000));
  });

  it("makes unclaimable tax part of the cost", async () => {
    const fixture = await createCompany();
    await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 11800,
        taxPercent: 18,
        claimInputCredit: false,
      }),
    });

    // The whole ₹11,800 is what the rent cost, because none of it comes back.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.RENT_EXPENSE),
    ).toBe(toStorageString(11800));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(0));
  });

  it("refuses credit to a composition dealer whatever the form asks", async () => {
    const fixture = await createCompany("COMPOSITION");
    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 11800,
        taxPercent: 18,
        claimInputCredit: true,
      }),
    });

    expect(posted.itcEligible).toBe(false);
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.RENT_EXPENSE),
    ).toBe(toStorageString(11800));
  });

  it("charges IGST when the payee is in another state", async () => {
    const fixture = await createCompany();
    const vendor = await createParty({
      companyId: fixture.companyId,
      kind: "SUPPLIER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: supplierInput({
        name: "Delhi Consultants",
        gstin: "07AABCA1234C1Z5",
        stateCode: "07",
      }),
    });

    await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 11800,
        taxPercent: 18,
        supplierId: vendor.id,
      }),
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_IGST),
    ).toBe(toStorageString(1800));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(0));
  });

  it("writes nothing to the GST register when there is no tax", async () => {
    const fixture = await createCompany();
    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.salaryCategoryId, { amount: 28000 }),
    });

    // Salary carries no GST, and a register row of zeroes is noise in a return.
    expect(
      await prisma.gstTransaction.count({
        where: { companyId: fixture.companyId, documentId: posted.id },
      }),
    ).toBe(0);
  });
});

describe("capital expenditure", () => {
  it("routes an asset to fixed assets, not to the profit and loss", async () => {
    const fixture = await createCompany();

    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 40000,
        isCapitalExpenditure: true,
        assetName: "Display fridge",
        assetUsefulLifeMonths: 120,
      }),
    });

    expect(posted.isCapitalExpenditure).toBe(true);
    expect(posted.assetCode).toBe(`FA-${posted.voucherNumber}`);

    // Recording a fridge as an expense would understate profit this month and
    // overstate it every month afterwards.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.FIXED_ASSETS),
    ).toBe(toStorageString(40000));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.RENT_EXPENSE),
    ).toBe(toStorageString(0));

    await assertTrialBalances(fixture.companyId);
  });

  it("puts the asset in the register so it can be depreciated", async () => {
    const fixture = await createCompany();
    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 40000,
        isCapitalExpenditure: true,
        assetName: "Display fridge",
        assetUsefulLifeMonths: 120,
      }),
    });

    const asset = await prisma.fixedAsset.findFirstOrThrow({
      where: { companyId: fixture.companyId, code: posted.assetCode ?? "" },
      select: {
        name: true,
        purchaseCost: true,
        bookValue: true,
        usefulLifeMonths: true,
        isActive: true,
      },
    });
    expect(asset.name).toBe("Display fridge");
    expect(toStorageString(asset.purchaseCost)).toBe(toStorageString(40000));
    expect(toStorageString(asset.bookValue)).toBe(toStorageString(40000));
    expect(asset.usefulLifeMonths).toBe(120);
    expect(asset.isActive).toBe(true);
  });

  it("capitalises unclaimable tax along with the asset", async () => {
    const fixture = await createCompany("COMPOSITION");
    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 47200,
        taxPercent: 18,
        isCapitalExpenditure: true,
        assetName: "Display fridge",
      }),
    });

    // The asset cost the business the whole ₹47,200; none of the tax returns.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.FIXED_ASSETS),
    ).toBe(toStorageString(47200));

    const asset = await prisma.fixedAsset.findFirstOrThrow({
      where: { companyId: fixture.companyId, code: posted.assetCode ?? "" },
      select: { purchaseCost: true },
    });
    expect(toStorageString(asset.purchaseCost)).toBe(toStorageString(47200));
  });

  it("keeps a capitalised item out of the cost figure on the list", async () => {
    const fixture = await createCompany();
    await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, { amount: 25000 }),
    });
    await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 40000,
        isCapitalExpenditure: true,
        assetName: "Display fridge",
      }),
    });

    const listed = await listExpenses({ companyId: fixture.companyId });
    expect(listed.postedExpense).toBe(toStorageString(25000));
    expect(listed.capitalised).toBe(toStorageString(40000));
  });
});

describe("voiding", () => {
  it("reverses the entry and leaves both sides in the ledger", async () => {
    const fixture = await createCompany();
    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 11800,
        taxPercent: 18,
      }),
    });

    await voidExpense({
      companyId: fixture.companyId,
      expenseId: posted.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Recorded against the wrong month",
    });

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.RENT_EXPENSE),
    ).toBe(toStorageString(0));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.GST_INPUT_CGST),
    ).toBe(toStorageString(0));
    expect(await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.CASH)).toBe(
      toStorageString(0),
    );

    const entries = await prisma.journalEntry.findMany({
      where: { companyId: fixture.companyId, sourceId: posted.id },
      select: { status: true },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.status).toBe("REVERSED");

    const gstNet = await prisma.gstTransaction.aggregate({
      where: { companyId: fixture.companyId, documentId: posted.id },
      _sum: { totalTax: true },
    });
    expect(toStorageString(gstNet._sum.totalTax ?? 0)).toBe(toStorageString(0));

    await assertTrialBalances(fixture.companyId);
  });

  it("withdraws the asset when a capitalised expense is voided", async () => {
    const fixture = await createCompany();
    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId, {
        amount: 40000,
        isCapitalExpenditure: true,
        assetName: "Display fridge",
      }),
    });

    await voidExpense({
      companyId: fixture.companyId,
      expenseId: posted.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Never actually bought",
    });

    // Leaving it active would mean depreciating something the books say was
    // never bought, carrying the mistake forward for years.
    const asset = await prisma.fixedAsset.findFirstOrThrow({
      where: { companyId: fixture.companyId, code: posted.assetCode ?? "" },
      select: { isActive: true, disposedAt: true },
    });
    expect(asset.isActive).toBe(false);
    expect(asset.disposedAt).not.toBeNull();

    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.FIXED_ASSETS),
    ).toBe(toStorageString(0));
  });

  it("refuses to void the same expense twice", async () => {
    const fixture = await createCompany();
    const posted = await createExpense({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: expenseInput(fixture.rentCategoryId),
    });

    const voidIt = () =>
      voidExpense({
        companyId: fixture.companyId,
        expenseId: posted.id,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        reason: "Duplicate entry",
      });

    await voidIt();
    await expect(voidIt()).rejects.toThrow(/already been voided/);
  });
});

describe("tenant isolation", () => {
  it("cannot post against another company's category", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    await expect(
      createExpense({
        companyId: mine.companyId,
        userId: mine.userId,
        actorEmail: mine.actorEmail,
        branchId: null,
        input: expenseInput(theirs.rentCategoryId),
      }),
    ).rejects.toThrow(ExpenseError);
  });

  it("cannot void another company's expense", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    const theirExpense = await createExpense({
      companyId: theirs.companyId,
      userId: theirs.userId,
      actorEmail: theirs.actorEmail,
      branchId: null,
      input: expenseInput(theirs.rentCategoryId),
    });

    await expect(
      voidExpense({
        companyId: mine.companyId,
        expenseId: theirExpense.id,
        userId: mine.userId,
        actorEmail: mine.actorEmail,
        reason: "Not mine to void",
      }),
    ).rejects.toThrow(/could not be found/);
  });
});
