import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { JournalEntryInput } from "@/lib/validation/journal";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import {
  accountBalances,
  accountingEquation,
} from "@/server/accounting/balances";
import { listAccountMeta } from "@/server/accounting/balances";
import {
  createManualEntry,
  describeSource,
  documentPath,
  getJournalEntry,
  listJournalEntries,
  postableAccounts,
  reverseManualEntry,
  JournalError,
} from "@/server/accounting/journal-service";
import {
  STATEMENT_POSTING_SOURCE,
  STATEMENT_POSTING_REVERSAL_SOURCE,
} from "@/server/banking/record-from-statement";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The journal.
 *
 * A manual entry is the one place a person can move any figure in the business
 * to any other, so what is tested here is mostly what it refuses to do: post to
 * a control account without saying whose balance it moves, post to an account
 * that has been put away, reach into another company's chart, or reverse an
 * entry that belongs to a document.
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
      businessName: "Journal Test Mart",
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
  const email = `jrnl-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };
}

async function accountId(
  companyId: string,
  systemKey: string,
): Promise<string> {
  const meta = await listAccountMeta(companyId, { includeInactive: true });
  const found = meta.find((entry) => entry.systemKey === systemKey);
  if (!found) throw new Error(`No account for ${systemKey}`);
  return found.id;
}

const today = () => new Date().toISOString().slice(0, 10);

function entryInput(
  lines: JournalEntryInput["lines"],
  overrides: Partial<JournalEntryInput> = {},
): JournalEntryInput {
  return {
    entryDate: today(),
    voucherType: "JOURNAL",
    narration: "Depreciation on the display fridge for the year",
    referenceNo: "",
    lines,
    ...overrides,
  };
}

/** A credit sale, so the journal has a document-derived entry in it. */
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
      invoiceDate: today(),
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

  return { sale, customer };
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

describe("posting an entry by hand", () => {
  it("posts a balanced entry through the same engine as every module", async () => {
    const fixture = await createCompany();
    const depreciation = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.DEPRECIATION_EXPENSE,
    );
    const accumulated = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCUMULATED_DEPRECIATION,
    );

    const entry = await createManualEntry({
      companyId: fixture.companyId,
      branchId: null,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: entryInput([
        {
          accountId: depreciation,
          debit: 4000,
          credit: 0,
          narration: "",
          partyId: "",
        },
        {
          accountId: accumulated,
          debit: 0,
          credit: 4000,
          narration: "",
          partyId: "",
        },
      ]),
    });

    expect(entry.entryNumber).toMatch(/^JV-/);
    expect(entry.total).toBe(toStorageString(4000));

    const balances = await accountBalances({ companyId: fixture.companyId });
    expect(
      balances
        .find(
          (entry_) => entry_.systemKey === SYSTEM_ACCOUNT.DEPRECIATION_EXPENSE,
        )
        ?.balance.toFixed(2),
    ).toBe("4000.00");
    // A contra-asset: credit nature, so a credit balance is positive.
    expect(
      balances
        .find(
          (entry_) =>
            entry_.systemKey === SYSTEM_ACCOUNT.ACCUMULATED_DEPRECIATION,
        )
        ?.balance.toFixed(2),
    ).toBe("4000.00");
    expect(accountingEquation(balances).balanced).toBe(true);
  });

  it("marks it as typed rather than derived", async () => {
    const fixture = await createCompany();
    const cash = await accountId(fixture.companyId, SYSTEM_ACCOUNT.CASH);
    const bank = await accountId(fixture.companyId, SYSTEM_ACCOUNT.BANK);

    const entry = await createManualEntry({
      companyId: fixture.companyId,
      branchId: null,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: entryInput(
        [
          {
            accountId: bank,
            debit: 20000,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: cash,
            debit: 0,
            credit: 20000,
            narration: "",
            partyId: "",
          },
        ],
        { voucherType: "CONTRA", narration: "Cash banked on Friday" },
      ),
    });

    const detail = await getJournalEntry({
      companyId: fixture.companyId,
      entryId: entry.id,
    });

    expect(detail.isManual).toBe(true);
    expect(detail.isSystem).toBe(false);
    expect(detail.source).toBeNull();
    expect(detail.voucherType).toBe("CONTRA");
    expect(detail.lines).toHaveLength(2);
  });

  it("requires a party on a control account, and says why", async () => {
    const fixture = await createCompany();
    const receivables = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const badDebt = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
    );

    await expect(
      createManualEntry({
        companyId: fixture.companyId,
        branchId: null,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: entryInput([
          {
            accountId: badDebt,
            debit: 500,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: receivables,
            debit: 0,
            credit: 500,
            narration: "",
            partyId: "",
          },
        ]),
      }),
    ).rejects.toThrow(/never be chased or settled/i);
  });

  it("writes off a named customer's debt", async () => {
    const fixture = await createCompany();
    const { customer } = await tradeOnce(fixture);
    const receivables = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const badDebt = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
    );

    const entry = await createManualEntry({
      companyId: fixture.companyId,
      branchId: null,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: entryInput(
        [
          {
            accountId: badDebt,
            debit: 1180,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: receivables,
            debit: 0,
            credit: 1180,
            narration: "",
            partyId: customer.id,
          },
        ],
        { narration: "Sharma Provision Store closed down; debt written off" },
      ),
    });

    const detail = await getJournalEntry({
      companyId: fixture.companyId,
      entryId: entry.id,
    });
    // The line names who it belongs to, so the sub-ledger stays resolvable.
    expect(detail.lines.find((line) => line.partyName)?.partyName).toBe(
      "Sharma Provision Store",
    );

    const balances = await accountBalances({ companyId: fixture.companyId });
    expect(
      balances
        .find(
          (entry_) => entry_.systemKey === SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
        )
        ?.balance.toFixed(2),
    ).toBe("0.00");
    expect(accountingEquation(balances).balanced).toBe(true);
  });

  it("refuses a party belonging to another company", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    const { customer } = await tradeOnce(beta);

    const receivables = await accountId(
      alpha.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const badDebt = await accountId(
      alpha.companyId,
      SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
    );

    await expect(
      createManualEntry({
        companyId: alpha.companyId,
        branchId: null,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        input: entryInput([
          {
            accountId: badDebt,
            debit: 100,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: receivables,
            debit: 0,
            credit: 100,
            narration: "",
            partyId: customer.id,
          },
        ]),
      }),
    ).rejects.toThrow(/not in your records/i);
  });

  it("refuses an account belonging to another company", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();

    const mine = await accountId(alpha.companyId, SYSTEM_ACCOUNT.CASH);
    const theirs = await accountId(beta.companyId, SYSTEM_ACCOUNT.BANK);

    await expect(
      createManualEntry({
        companyId: alpha.companyId,
        branchId: null,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        input: entryInput([
          {
            accountId: mine,
            debit: 100,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: theirs,
            debit: 0,
            credit: 100,
            narration: "",
            partyId: "",
          },
        ]),
      }),
    ).rejects.toThrow(/does not exist in your chart/i);

    // Nothing was written on either side.
    expect(
      (
        await listJournalEntries({
          companyId: alpha.companyId,
          origin: "manual",
        })
      ).total,
    ).toBe(0);
  });

  it("refuses an account that has been put away", async () => {
    const fixture = await createCompany();
    const cash = await accountId(fixture.companyId, SYSTEM_ACCOUNT.CASH);
    const misc = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
    );

    await prisma.account.update({
      where: { id: misc },
      data: { isActive: false },
    });

    await expect(
      createManualEntry({
        companyId: fixture.companyId,
        branchId: null,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        input: entryInput([
          {
            accountId: misc,
            debit: 100,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: cash,
            debit: 0,
            credit: 100,
            narration: "",
            partyId: "",
          },
        ]),
      }),
    ).rejects.toThrow(/put away/i);
  });

  it("does not offer a retired account for posting", async () => {
    const fixture = await createCompany();
    const misc = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
    );
    await prisma.account.update({
      where: { id: misc },
      data: { isActive: false },
    });

    const offered = await postableAccounts(fixture.companyId);
    expect(offered.some((account) => account.id === misc)).toBe(false);
    // And it tells the form which accounts need a name against them.
    expect(
      offered.find((account) => account.partyType === "CUSTOMER"),
    ).toBeDefined();
  });
});

describe("reversing an entry", () => {
  it("posts a mirror and leaves both in the ledger", async () => {
    const fixture = await createCompany();
    const cash = await accountId(fixture.companyId, SYSTEM_ACCOUNT.CASH);
    const bank = await accountId(fixture.companyId, SYSTEM_ACCOUNT.BANK);

    const entry = await createManualEntry({
      companyId: fixture.companyId,
      branchId: null,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: entryInput(
        [
          {
            accountId: bank,
            debit: 5000,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: cash,
            debit: 0,
            credit: 5000,
            narration: "",
            partyId: "",
          },
        ],
        { voucherType: "CONTRA", narration: "Cash banked" },
      ),
    });

    await reverseManualEntry({
      companyId: fixture.companyId,
      entryId: entry.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Banked to the wrong account",
    });

    const balances = await accountBalances({ companyId: fixture.companyId });
    expect(
      balances
        .find((entry_) => entry_.systemKey === SYSTEM_ACCOUNT.BANK)
        ?.balance.toFixed(2),
    ).toBe("0.00");
    expect(
      balances
        .find((entry_) => entry_.systemKey === SYSTEM_ACCOUNT.CASH)
        ?.balance.toFixed(2),
    ).toBe("0.00");

    const detail = await getJournalEntry({
      companyId: fixture.companyId,
      entryId: entry.id,
    });
    expect(detail.status).toBe("REVERSED");
    expect(detail.reversedBy?.entryNumber).toBeTruthy();

    // Both entries are still there.
    const all = await listJournalEntries({ companyId: fixture.companyId });
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.balanced).toBe(true);
  });

  it("refuses to reverse a document's entry, and says what to do instead", async () => {
    const fixture = await createCompany();
    const { sale } = await tradeOnce(fixture);

    const entries = await listJournalEntries({
      companyId: fixture.companyId,
      origin: "system",
    });
    const saleEntry = entries.rows.find((row) => row.source === "Invoice");
    expect(saleEntry).toBeDefined();

    await expect(
      reverseManualEntry({
        companyId: fixture.companyId,
        entryId: saleEntry!.id,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
        reason: "Should not be possible",
      }),
    ).rejects.toThrow(/Void the document instead/i);

    // The sale is untouched.
    const untouched = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      select: { status: true },
    });
    expect(untouched.status).toBe("POSTED");
  });

  it("refuses to reverse the same entry twice", async () => {
    const fixture = await createCompany();
    const cash = await accountId(fixture.companyId, SYSTEM_ACCOUNT.CASH);
    const bank = await accountId(fixture.companyId, SYSTEM_ACCOUNT.BANK);

    const entry = await createManualEntry({
      companyId: fixture.companyId,
      branchId: null,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: entryInput([
        { accountId: bank, debit: 100, credit: 0, narration: "", partyId: "" },
        { accountId: cash, debit: 0, credit: 100, narration: "", partyId: "" },
      ]),
    });

    const args = {
      companyId: fixture.companyId,
      entryId: entry.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Entered twice",
    };
    await reverseManualEntry(args);
    await expect(reverseManualEntry(args)).rejects.toThrow(
      /already been reversed/i,
    );
  });

  it("will not reverse another company's entry", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();

    const cash = await accountId(beta.companyId, SYSTEM_ACCOUNT.CASH);
    const bank = await accountId(beta.companyId, SYSTEM_ACCOUNT.BANK);
    const theirs = await createManualEntry({
      companyId: beta.companyId,
      branchId: null,
      userId: beta.userId,
      actorEmail: beta.actorEmail,
      input: entryInput([
        { accountId: bank, debit: 100, credit: 0, narration: "", partyId: "" },
        { accountId: cash, debit: 0, credit: 100, narration: "", partyId: "" },
      ]),
    });

    await expect(
      reverseManualEntry({
        companyId: alpha.companyId,
        entryId: theirs.id,
        userId: alpha.userId,
        actorEmail: alpha.actorEmail,
        reason: "Should not be possible",
      }),
    ).rejects.toThrow(JournalError);
  });
});

describe("the register", () => {
  it("lists every entry, whatever produced it", async () => {
    const fixture = await createCompany();
    await tradeOnce(fixture);

    const all = await listJournalEntries({ companyId: fixture.companyId });
    // Opening stock, and the sale.
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.rows.some((row) => row.source === "Invoice")).toBe(true);
    expect(all.balanced).toBe(true);
  });

  it("totals debits and credits across the whole filtered set", async () => {
    const fixture = await createCompany();
    await tradeOnce(fixture);

    const result = await listJournalEntries({ companyId: fixture.companyId });
    expect(result.totalDebit).toBe(result.totalCredit);
    expect(Number(result.totalDebit)).toBeGreaterThan(0);
  });

  it("separates entries somebody typed from ones the system derived", async () => {
    const fixture = await createCompany();
    await tradeOnce(fixture);
    const cash = await accountId(fixture.companyId, SYSTEM_ACCOUNT.CASH);
    const bank = await accountId(fixture.companyId, SYSTEM_ACCOUNT.BANK);
    await createManualEntry({
      companyId: fixture.companyId,
      branchId: null,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: entryInput([
        { accountId: bank, debit: 100, credit: 0, narration: "", partyId: "" },
        { accountId: cash, debit: 0, credit: 100, narration: "", partyId: "" },
      ]),
    });

    const manual = await listJournalEntries({
      companyId: fixture.companyId,
      origin: "manual",
    });
    expect(manual.total).toBe(1);
    expect(manual.rows[0]?.source).toBeNull();

    const derived = await listJournalEntries({
      companyId: fixture.companyId,
      origin: "system",
    });
    expect(derived.total).toBeGreaterThanOrEqual(1);
    expect(derived.rows.every((row) => row.source !== null)).toBe(true);
  });

  it("filters by voucher type and by date", async () => {
    const fixture = await createCompany();
    await tradeOnce(fixture);

    const sales = await listJournalEntries({
      companyId: fixture.companyId,
      voucherType: "SALES",
    });
    expect(sales.total).toBe(1);

    const future = await listJournalEntries({
      companyId: fixture.companyId,
      from: "2099-01-01",
    });
    expect(future.total).toBe(0);
  });

  it("finds an entry by its narration", async () => {
    const fixture = await createCompany();
    const cash = await accountId(fixture.companyId, SYSTEM_ACCOUNT.CASH);
    const bank = await accountId(fixture.companyId, SYSTEM_ACCOUNT.BANK);
    await createManualEntry({
      companyId: fixture.companyId,
      branchId: null,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: entryInput(
        [
          {
            accountId: bank,
            debit: 100,
            credit: 0,
            narration: "",
            partyId: "",
          },
          {
            accountId: cash,
            debit: 0,
            credit: 100,
            narration: "",
            partyId: "",
          },
        ],
        { narration: "Cash banked after the Diwali weekend" },
      ),
    });

    const found = await listJournalEntries({
      companyId: fixture.companyId,
      query: "diwali",
    });
    expect(found.total).toBe(1);
  });

  it("shows nobody else's entries", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    await tradeOnce(beta);

    expect(
      (await listJournalEntries({ companyId: alpha.companyId })).total,
    ).toBe(0);

    const theirs = (await listJournalEntries({ companyId: beta.companyId }))
      .rows[0];
    await expect(
      getJournalEntry({ companyId: alpha.companyId, entryId: theirs!.id }),
    ).rejects.toThrow(/could not be found/i);
  });

  it("links a document's entry back to the document", async () => {
    const fixture = await createCompany();
    const { sale } = await tradeOnce(fixture);

    const entries = await listJournalEntries({
      companyId: fixture.companyId,
      voucherType: "SALES",
    });
    const detail = await getJournalEntry({
      companyId: fixture.companyId,
      entryId: entries.rows[0]!.id,
    });

    expect(detail.isManual).toBe(false);
    expect(detail.source).toBe("Invoice");
    expect(documentPath(detail.sourceType, detail.sourceId)).toBe(
      `/app/sales/${sale.id}`,
    );
  });
});

describe("describing where an entry came from", () => {
  it("names each module in words", () => {
    expect(describeSource("SALE")).toBe("Invoice");
    expect(describeSource("PURCHASE")).toBe("Bill");
    expect(describeSource("RECEIPT")).toBe("Receipt");
    expect(describeSource("OPENING_BALANCE")).toBe("Opening balance");
  });

  it("names the two the banking module posts, rather than printing a constant", () => {
    // `describeSource` falls back to the source type itself, so a module that
    // adds one and forgets the label shows a table name — "BankTransaction" —
    // to somebody reading their own ledger.
    expect(describeSource(STATEMENT_POSTING_SOURCE)).toBe("Bank statement");
    expect(describeSource(STATEMENT_POSTING_REVERSAL_SOURCE)).toBe(
      "Bank statement reversal",
    );
  });

  it("says nothing for an entry somebody typed", () => {
    expect(describeSource("MANUAL_JOURNAL")).toBeNull();
    expect(describeSource(null)).toBeNull();
  });

  it("has no path for an entry with no document", () => {
    expect(documentPath("MANUAL_JOURNAL", "x")).toBeNull();
    expect(documentPath(null, null)).toBeNull();
    expect(documentPath("OPENING_BALANCE", "x")).toBeNull();
  });
});
