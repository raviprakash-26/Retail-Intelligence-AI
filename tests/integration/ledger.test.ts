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
import { createSale, voidSale } from "@/server/sales/sale-service";
import { createReceipt } from "@/server/settlements/settlement-service";
import { listAccountMeta } from "@/server/accounting/balances";
import {
  balanceSideLabel,
  describeBalance,
  getAccountLedger,
  ledgerAccounts,
  ledgerReconciles,
  partyStatement,
  LedgerError,
  LEDGER_PAGE_SIZE,
} from "@/server/accounting/ledger-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The ledger.
 *
 * The running balance is the thing worth testing hardest. It is computed by a
 * window function across the whole ordered set so that page two starts where
 * page one ended, and the ordering has a total tiebreak so two printouts of the
 * same ledger cannot disagree. Both are easy to get subtly wrong and neither
 * fails loudly.
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
      businessName: "Ledger Test Mart",
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

async function createCompany(): Promise<Fixture> {
  const email = `ldgr-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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

  // Zero-rated so the arithmetic in these tests is about the ledger, not GST.
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
      openingQuantity: 1000,
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
      creditLimit: 1000000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  return { ...base, productId: product.id, customerId: customer.id };
}

async function accountId(companyId: string, key: string): Promise<string> {
  const meta = await listAccountMeta(companyId, { includeInactive: true });
  const found = meta.find((entry) => entry.systemKey === key);
  if (!found) throw new Error(`No account for ${key}`);
  return found.id;
}

/** A zero-rated credit sale of `quantity` at ₹100, dated `date`. */
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

describe("a single account's ledger", () => {
  it("lists every posted line with a running balance", async () => {
    const fixture = await createCompany();
    await sell(fixture, 1); // ₹100
    await sell(fixture, 2); // ₹200
    await sell(fixture, 3); // ₹300

    const ledger = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: await accountId(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    });

    expect(ledger.rows).toHaveLength(3);
    expect(ledger.rows.map((row) => row.running)).toEqual([
      toStorageString(100),
      toStorageString(300),
      toStorageString(600),
    ]);
    expect(ledger.closingBalance).toBe(toStorageString(600));
    expect(ledgerReconciles(ledger)).toBe(true);
  });

  it("runs a credit-nature account the other way up", async () => {
    const fixture = await createCompany();
    await sell(fixture, 1);
    await sell(fixture, 2);

    const ledger = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: await accountId(fixture.companyId, SYSTEM_ACCOUNT.SALES),
    });

    // Sales is a credit account: credits increase it.
    expect(ledger.rows.map((row) => row.running)).toEqual([
      toStorageString(100),
      toStorageString(300),
    ]);
    expect(ledger.closingBalance).toBe(toStorageString(300));
    expect(ledgerReconciles(ledger)).toBe(true);
  });

  it("carries a balance in from before the window", async () => {
    const fixture = await createCompany();
    await sell(fixture, 5, "2026-05-10"); // ₹500, before the window
    await sell(fixture, 1, "2026-06-15"); // ₹100, inside it
    await sell(fixture, 2, "2026-06-20"); // ₹200, inside it

    const ledger = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: await accountId(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
      from: "2026-06-01",
      to: "2026-06-30",
    });

    expect(ledger.openingBalance).toBe(toStorageString(500));
    expect(ledger.rows).toHaveLength(2);
    // The running balance continues from the opening rather than restarting.
    expect(ledger.rows.map((row) => row.running)).toEqual([
      toStorageString(600),
      toStorageString(800),
    ]);
    expect(ledger.closingBalance).toBe(toStorageString(800));
    expect(ledgerReconciles(ledger)).toBe(true);
  });

  it("excludes what happened after the window closes", async () => {
    const fixture = await createCompany();
    await sell(fixture, 1, "2026-06-15");
    await sell(fixture, 9, "2026-07-15");

    const ledger = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: await accountId(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
      from: "2026-06-01",
      to: "2026-06-30",
    });

    expect(ledger.rows).toHaveLength(1);
    expect(ledger.closingBalance).toBe(toStorageString(100));
  });

  it("keeps the running balance correct across pages", async () => {
    // The trap this exists to catch: recomputing per page would restart the
    // balance at the opening figure and every page after the first would lie.
    const fixture = await createCompany();
    const count = LEDGER_PAGE_SIZE + 5;
    for (let index = 0; index < count; index += 1) {
      await sell(fixture, 1); // ₹100 each
    }

    const receivables = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );

    const first = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: receivables,
      page: 1,
    });
    const second = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: receivables,
      page: 2,
    });

    expect(first.rows).toHaveLength(LEDGER_PAGE_SIZE);
    expect(second.rows).toHaveLength(5);
    expect(first.total).toBe(count);
    expect(first.pageCount).toBe(2);

    expect(first.rows.at(-1)?.running).toBe(
      toStorageString(LEDGER_PAGE_SIZE * 100),
    );
    // Page two picks up exactly where page one stopped.
    expect(second.rows[0]?.running).toBe(
      toStorageString((LEDGER_PAGE_SIZE + 1) * 100),
    );
    expect(second.rows.at(-1)?.running).toBe(toStorageString(count * 100));
    expect(second.rows.at(-1)?.running).toBe(first.closingBalance);
  });

  it("orders identically every time, even for same-day entries", async () => {
    const fixture = await createCompany();
    for (let index = 0; index < 6; index += 1) {
      await sell(fixture, index + 1, "2026-06-10");
    }

    const receivables = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const once = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: receivables,
    });
    const twice = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: receivables,
    });

    expect(once.rows.map((row) => row.lineId)).toEqual(
      twice.rows.map((row) => row.lineId),
    );
    expect(once.rows.map((row) => row.running)).toEqual(
      twice.rows.map((row) => row.running),
    );
    // Ascending, because each sale is larger than the last.
    expect(once.rows.map((row) => Number(row.debit))).toEqual([
      100, 200, 300, 400, 500, 600,
    ]);
  });

  it("shows a voided document's original and its reversal, netting to nothing", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 4);

    await voidSale({
      companyId: fixture.companyId,
      saleId: sale.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Entered against the wrong customer",
    });

    const ledger = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: await accountId(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    });

    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0]?.debit).toBe(toStorageString(400));
    expect(ledger.rows[1]?.credit).toBe(toStorageString(400));
    expect(ledger.rows.at(-1)?.running).toBe(toStorageString(0));
    // The original is flagged, so a reader can see why it is cancelled.
    expect(ledger.rows[0]?.reversed).toBe(true);
    expect(ledger.closingBalance).toBe(toStorageString(0));
  });

  it("says which document produced each line and where to find it", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, 1);

    const ledger = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: await accountId(
        fixture.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    });

    expect(ledger.rows[0]?.source).toBe("Invoice");
    expect(ledger.rows[0]?.documentHref).toBe(`/app/sales/${sale.id}`);
    expect(ledger.rows[0]?.entryNumber).toBeTruthy();
  });

  it("returns an empty ledger rather than failing on an untouched account", async () => {
    const fixture = await createCompany();
    const ledger = await getAccountLedger({
      companyId: fixture.companyId,
      accountId: await accountId(fixture.companyId, SYSTEM_ACCOUNT.BANK),
    });

    expect(ledger.rows).toEqual([]);
    expect(ledger.total).toBe(0);
    expect(ledger.closingBalance).toBe(toStorageString(0));
    expect(ledger.pageCount).toBe(1);
  });

  it("will not open another company's account", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();

    await expect(
      getAccountLedger({
        companyId: alpha.companyId,
        accountId: await accountId(beta.companyId, SYSTEM_ACCOUNT.CASH),
      }),
    ).rejects.toThrow(LedgerError);
  });

  it("never shows another company's lines", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    await sell(beta, 7);

    const ledger = await getAccountLedger({
      companyId: alpha.companyId,
      accountId: await accountId(
        alpha.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    });
    expect(ledger.rows).toEqual([]);
    expect(ledger.closingBalance).toBe(toStorageString(0));
  });
});

describe("a party's statement", () => {
  it("narrows the control account to one name", async () => {
    const fixture = await createCompany();
    const other = await createParty({
      companyId: fixture.companyId,
      kind: "CUSTOMER",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        name: "Lakshmi Kirana",
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

    await sell(fixture, 3); // Sharma, ₹300
    await createSale({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        customerId: other.id,
        invoiceDate: new Date().toISOString().slice(0, 10),
        paymentMode: "CREDIT",
        placeOfSupply: "",
        priceIncludesTax: false,
        notes: "",
        lines: [
          {
            productId: fixture.productId,
            description: "",
            quantity: 9,
            rate: 100,
            discountPercent: 0,
          },
        ],
      } satisfies SaleInput,
    });

    const statement = await partyStatement({
      companyId: fixture.companyId,
      partyType: "CUSTOMER",
      partyId: fixture.customerId,
    });

    expect(statement.party?.name).toBe("Sharma Provision Store");
    expect(statement.rows).toHaveLength(1);
    expect(statement.closingBalance).toBe(toStorageString(300));
    expect(statement.rows[0]?.partyName).toBe("Sharma Provision Store");
  });

  it("reconciles with what a receipt settles", async () => {
    const fixture = await createCompany();
    await sell(fixture, 5); // ₹500

    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "CUSTOMER",
        partyId: fixture.customerId,
        date: new Date().toISOString().slice(0, 10),
        paymentMode: "CASH",
        amount: 200,
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    const statement = await partyStatement({
      companyId: fixture.companyId,
      partyType: "CUSTOMER",
      partyId: fixture.customerId,
    });

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows.map((row) => row.running)).toEqual([
      toStorageString(500),
      toStorageString(300),
    ]);
    expect(statement.closingBalance).toBe(toStorageString(300));
  });

  it("refuses a party filter on an account that has no parties", async () => {
    const fixture = await createCompany();

    await expect(
      getAccountLedger({
        companyId: fixture.companyId,
        accountId: await accountId(fixture.companyId, SYSTEM_ACCOUNT.CASH),
        partyId: fixture.customerId,
      }),
    ).rejects.toThrow(/not a control account/i);
  });

  it("shows nothing for a party belonging to another company", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    await sell(beta, 4);

    const statement = await partyStatement({
      companyId: alpha.companyId,
      partyType: "CUSTOMER",
      partyId: beta.customerId,
    });

    expect(statement.rows).toEqual([]);
    expect(statement.closingBalance).toBe(toStorageString(0));
  });
});

describe("choosing an account", () => {
  it("offers the chart, flagging which have history", async () => {
    const fixture = await createCompany();
    await sell(fixture, 1);

    const options = await ledgerAccounts(fixture.companyId);
    const receivables = options.find((option) => option.code === "1121");
    const bank = options.find((option) => option.code === "1112");

    expect(receivables?.used).toBe(true);
    expect(bank?.used).toBe(false);
    expect(receivables?.partyType).toBe("CUSTOMER");
  });

  it("keeps a retired account that still carries history", async () => {
    // An account put away in March is exactly the one somebody wants to look
    // at in June; hiding it would make last year's figures unexplainable.
    const fixture = await createCompany();
    await sell(fixture, 1);

    const receivables = await accountId(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const bank = await accountId(fixture.companyId, SYSTEM_ACCOUNT.BANK);
    await prisma.account.updateMany({
      where: { id: { in: [receivables, bank] } },
      data: { isActive: false },
    });

    const options = await ledgerAccounts(fixture.companyId);
    expect(options.some((option) => option.id === receivables)).toBe(true);
    // Retired and never used: nothing to explain, so it is not offered.
    expect(options.some((option) => option.id === bank)).toBe(false);
  });
});

describe("reading a balance aloud", () => {
  it("says who owes whom rather than Dr and Cr", () => {
    expect(
      describeBalance({
        type: "ASSET",
        nature: "DEBIT",
        balance: "1180",
        partyName: "Sharma Provision Store",
      }),
    ).toBe("Sharma Provision Store owes you this much");

    expect(
      describeBalance({
        type: "LIABILITY",
        nature: "CREDIT",
        balance: "500",
        partyName: "ABC Traders",
      }),
    ).toBe("You owe ABC Traders this much");
  });

  it("handles a party who has paid in advance", () => {
    expect(
      describeBalance({
        type: "ASSET",
        nature: "DEBIT",
        balance: "-300",
        partyName: "Sharma Provision Store",
      }),
    ).toBe("Sharma Provision Store is in credit with you");
  });

  it("says nothing outstanding when the balance is nil", () => {
    expect(
      describeBalance({ type: "ASSET", nature: "DEBIT", balance: "0" }),
    ).toBe("Nothing outstanding");
  });

  it("labels the side a balance actually sits on", () => {
    expect(balanceSideLabel({ nature: "DEBIT", balance: "500" })).toBe("Dr");
    expect(balanceSideLabel({ nature: "DEBIT", balance: "-500" })).toBe("Cr");
    expect(balanceSideLabel({ nature: "DEBIT", balance: "0" })).toBe("");
  });

  /**
   * The tag has to agree with the sentence beside it.
   *
   * A ledger balance is signed against the account's own nature — positive
   * means "on the side this account normally sits on". So on payables a
   * positive figure is money the shop owes, and it sits on the *credit* side;
   * reading the sign alone called it Dr, which on a supplier account says the
   * supplier owes the shop. The page printed "You owe Metro Wholesale this
   * much" and "₹30,000 Dr" one line apart, each contradicting the other, on
   * the statement a shop would send its supplier.
   *
   * Backwards for every credit-nature account in the chart, which is every
   * liability, all income, capital — and accumulated depreciation, an asset
   * held at credit nature precisely because it is a contra.
   */
  it("puts a credit-nature balance on the credit side", () => {
    // The shop owes ₹30,000. That is a credit balance on payables.
    expect(balanceSideLabel({ nature: "CREDIT", balance: "30000" })).toBe("Cr");
    // And an overpaid supplier leaves a debit balance.
    expect(balanceSideLabel({ nature: "CREDIT", balance: "-30000" })).toBe(
      "Dr",
    );
    expect(balanceSideLabel({ nature: "CREDIT", balance: "0" })).toBe("");
  });

  it("agrees with the sentence it is printed beside", () => {
    // The page prints these two one line apart, so they have to say the same
    // thing about the same balance. Money the shop is owed is a debit on a
    // party account; money it owes is a credit.
    const cases = [
      {
        type: "LIABILITY",
        nature: "CREDIT",
        balance: "30000",
        sentence: "You owe Metro Wholesale this much",
        side: "Cr",
      },
      {
        type: "LIABILITY",
        nature: "CREDIT",
        balance: "-30000",
        sentence: "You are in credit with Metro Wholesale",
        side: "Dr",
      },
      {
        type: "ASSET",
        nature: "DEBIT",
        balance: "1180",
        sentence: "Metro Wholesale owes you this much",
        side: "Dr",
      },
      {
        type: "ASSET",
        nature: "DEBIT",
        balance: "-1180",
        sentence: "Metro Wholesale is in credit with you",
        side: "Cr",
      },
    ] as const;

    for (const entry of cases) {
      expect(
        describeBalance({
          type: entry.type,
          nature: entry.nature,
          balance: entry.balance,
          partyName: "Metro Wholesale",
        }),
      ).toBe(entry.sentence);

      expect(
        balanceSideLabel({ nature: entry.nature, balance: entry.balance }),
      ).toBe(entry.side);
    }
  });
});
