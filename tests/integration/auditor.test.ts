import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditFindingStatus } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { subtract, toStorageString } from "@/lib/money";
import { accuses, RULES_VERSION } from "@/lib/auditor/rules";
import type { RegisterInput } from "@/lib/validation/auth";
import type {
  CustomerInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import type { PurchaseInput } from "@/lib/validation/purchases";
import type { SaleInput } from "@/lib/validation/sales";
import type { PaymentInput } from "@/lib/validation/settlements";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import { createSale } from "@/server/sales/sale-service";
import {
  createSalesReturn,
  returnableLines,
} from "@/server/returns/sales-return-service";
import {
  createPayment,
  createReceipt,
} from "@/server/settlements/settlement-service";
import {
  getLatestAudit,
  runAudit,
  settleFinding,
} from "@/server/auditor/audit-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The auditor.
 *
 * Two things are being protected. Findings have to be real — a check that fires
 * on a clean set of books trains everybody to ignore the list — and no finding
 * may ever say more than the query establishes. The second is asserted against
 * every finding a run actually produces, not only against the catalogue.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

const DAY = 86_400_000;
const TODAY = new Date();
const daysBefore = (days: number): string =>
  new Date(TODAY.getTime() - days * DAY).toISOString().slice(0, 10);

const WINDOW = {
  from: new Date(TODAY.getTime() - 365 * DAY),
  to: new Date(TODAY.getTime() + DAY),
};

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
      businessName: `Audit ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 20000,
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
  supplierId: string;
};

async function createCompany(): Promise<Fixture> {
  const email = `audit-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
  const rate = taxonomy.taxRates[0];
  if (!unit || !rate) throw new Error("Provisioning is incomplete");

  const product = await createProduct({
    ...base,
    input: {
      sku: "WIDGET",
      name: "Widget",
      description: "",
      barcode: "",
      hsnCode: "1006",
      categoryId: "",
      unitId: unit.id,
      taxRateId: rate.id,
      purchasePrice: 60,
      sellingPrice: 100,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 5_000,
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
      stateCode: "29",
      pincode: "",
      creditDays: 30,
      creditLimit: 100_000_000,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  const supplier = await createParty({
    ...base,
    kind: "SUPPLIER",
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
    } satisfies SupplierInput,
  });

  return {
    ...base,
    productId: product.id,
    customerId: customer.id,
    supplierId: supplier.id,
  };
}

async function sell(
  fixture: Fixture,
  options: {
    quantity: number;
    rate: number;
    date?: string;
    paymentMode?: "CREDIT" | "CASH";
    /** Taken off the rate, which is how a shop actually clears old stock. */
    discountPercent?: number;
    /** A shelf price with the tax already in it. */
    priceIncludesTax?: boolean;
    /** Defaults to the fixture's own product, which carries no tax. */
    productId?: string;
  },
) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: options.date ?? daysBefore(1),
      paymentMode: options.paymentMode ?? "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: options.priceIncludesTax ?? false,
      notes: "",
      lines: [
        {
          productId: options.productId ?? fixture.productId,
          description: "",
          quantity: options.quantity,
          rate: options.rate,
          discountPercent: options.discountPercent ?? 0,
        },
      ],
    } satisfies SaleInput,
  });
}

/**
 * A second product, on a real GST rate rather than the fixture's nil one.
 *
 * The taxonomy hands back rates cheapest first, so the shop's own product is
 * tax-free and an inclusive shelf price on it would be the same figure either
 * way. Costing the same ₹60 keeps the arithmetic next to the case above it.
 */
async function taxedProduct(fixture: Fixture): Promise<string> {
  const taxonomy = await getProductTaxonomy(fixture.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

  const product = await createProduct({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    input: {
      sku: "TAXED",
      name: "Taxed widget",
      description: "",
      barcode: "",
      hsnCode: "1006",
      categoryId: "",
      unitId: unit.id,
      taxRateId: gst18.id,
      purchasePrice: 60,
      sellingPrice: 100,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 5_000,
      openingRate: 60,
      minStockLevel: 0,
    } satisfies ProductInput,
  });
  return product.id;
}

/**
 * A supplier bill paid for in cash across the counter.
 *
 * No payment voucher is created for one of these — the bill carries the
 * settlement itself — which is what made it invisible to a check that read
 * payment vouchers.
 */
async function buyForCash(fixture: Fixture, rate: number): Promise<number> {
  const bill = await createPurchase({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      supplierId: fixture.supplierId,
      supplierBillNo: uniqueSlug("SB").toUpperCase(),
      billDate: daysBefore(4),
      paymentMode: "CASH",
      priceIncludesTax: false,
      claimInputCredit: true,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: 1,
          rate,
          discountPercent: 0,
        },
      ],
    } satisfies PurchaseInput,
  });

  // What the bill came to, rather than what this helper guessed it would: the
  // fixture's tax rate is provisioning's business, not this test's.
  const posted = await prisma.purchase.findUniqueOrThrow({
    where: { id: bill.id },
    select: { totalAmount: true },
  });
  return Number(posted.totalAmount);
}

/** Net debit on a system account. Credit-natured accounts read negative. */
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

const audit = (fixture: Fixture) =>
  runAudit({ companyId: fixture.companyId, ...WINDOW });

const keysOf = (report: Awaited<ReturnType<typeof runAudit>>) =>
  report.findings.map((finding) => finding.ruleKey);

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

describe("a clean set of books", () => {
  it("trips nothing", async () => {
    // A check that fires on a shop doing nothing wrong trains everybody to
    // ignore the list.
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 100 });

    const report = await audit(fixture);
    expect(keysOf(report)).toEqual([]);
    expect(report.run?.score).toBe(100);
    expect(report.run?.riskLevel).toBe("INFO");
  });

  it("records the run with the rules that produced it", async () => {
    const fixture = await createCompany();
    const report = await audit(fixture);

    expect(report.run?.rulesVersion).toBe(RULES_VERSION);
    expect(report.run?.completedAt).not.toBeNull();
  });
});

describe("what the checks find", () => {
  it("notices cash going below zero", async () => {
    // The finding deferred through every earlier phase finally has a home.
    const fixture = await createCompany();
    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "SUPPLIER",
        partyId: fixture.supplierId,
        date: daysBefore(3),
        paymentMode: "CASH",
        amount: 80_000, // more than the ₹20,000 opening balance
        referenceNo: "",
        notes: "",
        allocations: [],
      } satisfies PaymentInput,
    });

    const report = await audit(fixture);
    expect(keysOf(report)).toContain("NEGATIVE_CASH_BALANCE");

    const finding = report.findings.find(
      (entry) => entry.ruleKey === "NEGATIVE_CASH_BALANCE",
    );
    expect(finding?.evidence.firstDate).toBe(daysBefore(3));
    expect(Number(finding?.evidence.balanceThatDay)).toBeLessThan(0);
  });

  it("notices two identical invoices to one customer on one day", async () => {
    const fixture = await createCompany();
    await sell(fixture, { quantity: 5, rate: 100, date: daysBefore(2) });
    await sell(fixture, { quantity: 5, rate: 100, date: daysBefore(2) });

    const report = await audit(fixture);
    const finding = report.findings.find(
      (entry) => entry.ruleKey === "DUPLICATE_INVOICE_SAME_DAY",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence.copies).toBe(2);
    expect(finding?.evidence.customer).toBe("Sharma Provision Store");
  });

  it("does not call two different amounts a duplicate", async () => {
    const fixture = await createCompany();
    await sell(fixture, { quantity: 5, rate: 100, date: daysBefore(2) });
    await sell(fixture, { quantity: 6, rate: 100, date: daysBefore(2) });

    const report = await audit(fixture);
    expect(keysOf(report)).not.toContain("DUPLICATE_INVOICE_SAME_DAY");
  });

  it("notices something sold below what it cost", async () => {
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 40 }); // cost is 60

    const report = await audit(fixture);
    const finding = report.findings.find(
      (entry) => entry.ruleKey === "SALE_BELOW_COST",
    );
    expect(finding).toBeDefined();
    expect(Number(finding?.evidence.soldAt)).toBeLessThan(
      Number(finding?.evidence.cost),
    );
  });

  it("notices a discount that took the price below cost", async () => {
    // The rule's own text offers "a promotion or a bulk discount priced an
    // item below cost" as one of three explanations for this finding, and the
    // check could not see a discount at all: it compared the rate before
    // anything came off it. ₹100 at half price is ₹50 against a ₹60 cost, and
    // comparing ₹100 to ₹60 said the shop was fine. Clearing old stock is the
    // whole reason a shopkeeper wants to be told.
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 100, discountPercent: 50 });

    const report = await audit(fixture);
    const finding = report.findings.find(
      (entry) => entry.ruleKey === "SALE_BELOW_COST",
    );
    expect(finding).toBeDefined();
    // And the evidence is the price actually charged, not the one struck out.
    expect(Number(finding?.evidence.soldAt)).toBeCloseTo(50, 2);
    expect(Number(finding?.evidence.cost)).toBeCloseTo(60, 2);
  });

  it("leaves a discount alone that still clears cost", async () => {
    // The other half of reading the discount: ₹100 at 10% off is ₹90 against
    // ₹60, which is an ordinary margin. A check that flagged every discounted
    // line would be ignored within a week.
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 100, discountPercent: 10 });

    const report = await audit(fixture);
    expect(keysOf(report)).not.toContain("SALE_BELOW_COST");
  });

  it("notices a shelf price that is below cost once the tax comes out", async () => {
    // A price with the tax already in it is not the shop's to keep. ₹70 at 18%
    // holds ₹59.32 of value against a ₹60 cost, so the line loses money — and
    // comparing the ₹70 on the label to the ₹60 cost said otherwise.
    const fixture = await createCompany();
    const productId = await taxedProduct(fixture);
    await sell(fixture, {
      quantity: 10,
      rate: 70,
      priceIncludesTax: true,
      productId,
    });

    const report = await audit(fixture);
    const finding = report.findings.find(
      (entry) => entry.ruleKey === "SALE_BELOW_COST",
    );
    expect(finding).toBeDefined();
    expect(Number(finding?.evidence.soldAt)).toBeCloseTo(59.32, 1);
  });

  it("notices cash paid over the section 40A(3) limit", async () => {
    const fixture = await createCompany();
    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "SUPPLIER",
        partyId: fixture.supplierId,
        date: daysBefore(4),
        paymentMode: "CASH",
        amount: 15_000,
        referenceNo: "",
        notes: "",
        allocations: [],
      } satisfies PaymentInput,
    });

    const report = await audit(fixture);
    const finding = report.findings.find(
      (entry) => entry.ruleKey === "CASH_PAYMENT_OVER_LIMIT",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence.paidTo).toBe("Metro Wholesale");
    expect(Number(finding?.evidence.total)).toBe(15_000);
  });

  /**
   * A bill settled in cash at the counter.
   *
   * There is no payment voucher for one of these — the amount sits on the bill
   * itself — so a check that reads expenses and payment vouchers cannot see it.
   * That is the rule's own worked example: "a supplier who does not take bank
   * transfers was paid for a large delivery". The income tax working paper has
   * always counted it and disallowed the deduction, so the computation took the
   * money away while the check meant to warn about it beforehand said nothing.
   */
  it("notices a supplier bill settled in cash at the counter", async () => {
    const fixture = await createCompany();
    const billTotal = await buyForCash(fixture, 15_000);
    expect(billTotal).toBeGreaterThan(10_000);

    const report = await audit(fixture);
    const finding = report.findings.find(
      (entry) => entry.ruleKey === "CASH_PAYMENT_OVER_LIMIT",
    );

    expect(finding).toBeDefined();
    expect(finding?.evidence.paidTo).toBe("Metro Wholesale");
    expect(Number(finding?.evidence.total)).toBe(billTotal);
  });

  it("adds a bill and a voucher to the same supplier on one day together", async () => {
    // Neither is over the limit alone. Section 40A(3) is about the total to one
    // person in one day, and splitting a payment across two kinds of document
    // is exactly what the aggregation exists to defeat.
    const fixture = await createCompany();
    const billTotal = await buyForCash(fixture, 6_000);
    expect(billTotal).toBeLessThan(10_000);
    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "SUPPLIER",
        partyId: fixture.supplierId,
        date: daysBefore(4),
        paymentMode: "CASH",
        amount: 6_000,
        referenceNo: "",
        notes: "",
        allocations: [],
      } satisfies PaymentInput,
    });

    const report = await audit(fixture);
    const finding = report.findings.find(
      (entry) => entry.ruleKey === "CASH_PAYMENT_OVER_LIMIT",
    );

    expect(finding).toBeDefined();
    expect(Number(finding?.evidence.total)).toBe(billTotal + 6_000);
    expect((finding?.evidence.vouchers as string[]).length).toBe(2);
  });

  it("says nothing about cash paid within the limit", async () => {
    const fixture = await createCompany();
    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "SUPPLIER",
        partyId: fixture.supplierId,
        date: daysBefore(4),
        paymentMode: "CASH",
        amount: 8_000,
        referenceNo: "",
        notes: "",
        allocations: [],
      } satisfies PaymentInput,
    });

    const report = await audit(fixture);
    expect(keysOf(report)).not.toContain("CASH_PAYMENT_OVER_LIMIT");
  });

  it("carries evidence a person can go and check", async () => {
    // A finding nobody can verify is an accusation.
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 40 });

    const report = await audit(fixture);
    for (const finding of report.findings) {
      expect(Object.keys(finding.evidence).length).toBeGreaterThan(0);
    }
  });
});

describe("nothing a run produces accuses anybody", () => {
  it("keeps the vocabulary clean across every finding it raises", async () => {
    const fixture = await createCompany();
    // A shop that trips several checks at once.
    await sell(fixture, { quantity: 10, rate: 40, date: daysBefore(2) });
    await sell(fixture, { quantity: 10, rate: 40, date: daysBefore(2) });
    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "SUPPLIER",
        partyId: fixture.supplierId,
        date: daysBefore(3),
        paymentMode: "CASH",
        amount: 90_000,
        referenceNo: "",
        notes: "",
        allocations: [],
      } satisfies PaymentInput,
    });

    const report = await audit(fixture);
    expect(report.findings.length).toBeGreaterThan(2);

    for (const finding of report.findings) {
      const text = [
        finding.title,
        finding.description,
        finding.recommendation ?? "",
        ...finding.ordinaryExplanations,
      ].join(" ");
      expect(accuses(text), `${finding.ruleKey} accuses`).toBe(false);
    }
  });

  it("gives every finding the ordinary explanations for what it found", async () => {
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 40 });

    const report = await audit(fixture);
    for (const finding of report.findings) {
      expect(finding.ordinaryExplanations.length).toBeGreaterThan(0);
    }
  });
});

describe("running again", () => {
  it("replaces what is still open rather than piling up", async () => {
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 40 });

    const first = await audit(fixture);
    const second = await audit(fixture);

    expect(second.findings).toHaveLength(first.findings.length);
    expect(second.run?.score).toBe(first.run?.score);
  });

  it("leaves alone what somebody has already dealt with", async () => {
    // A judgement made about a finding is worth more than the finding, and
    // re-raising it every night would train everybody to ignore the list.
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 40 });

    const first = await audit(fixture);
    const finding = first.findings[0];
    expect(finding).toBeDefined();

    await settleFinding({
      companyId: fixture.companyId,
      findingId: finding!.id,
      status: AuditFindingStatus.FALSE_POSITIVE,
      note: "Clearance sale, priced deliberately",
      userId: fixture.userId,
    });

    const after = await audit(fixture);
    expect(after.settled.some((entry) => entry.id === finding!.id)).toBe(true);

    const kept = await prisma.auditFinding.findUniqueOrThrow({
      where: { id: finding!.id },
      select: { status: true, resolutionNote: true, evidence: true },
    });
    expect(kept.status).toBe(AuditFindingStatus.FALSE_POSITIVE);
    // The judgement is an addition to the record, not a replacement for it.
    expect(kept.resolutionNote).toMatch(/Clearance sale/);
    expect(kept.evidence).not.toBeNull();
  });
});

describe("tenant isolation", () => {
  it("never reports on another company's books", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    await sell(mine, { quantity: 10, rate: 100 });
    await sell(theirs, { quantity: 10, rate: 40 });
    await sell(theirs, { quantity: 10, rate: 40 });

    const clean = await audit(mine);
    expect(clean.findings).toHaveLength(0);

    const dirty = await audit(theirs);
    expect(dirty.findings.length).toBeGreaterThan(0);

    // And reading it back stays on this side of the boundary.
    const readBack = await getLatestAudit({ companyId: mine.companyId });
    expect(readBack.findings).toHaveLength(0);
  });

  it("refuses to settle a finding belonging to another company", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    await sell(theirs, { quantity: 10, rate: 40 });
    const report = await audit(theirs);
    const finding = report.findings[0];
    expect(finding).toBeDefined();

    const updated = await settleFinding({
      companyId: mine.companyId,
      findingId: finding!.id,
      status: AuditFindingStatus.DISMISSED,
      userId: mine.userId,
    });

    expect(updated).toBe(false);
    const untouched = await prisma.auditFinding.findUniqueOrThrow({
      where: { id: finding!.id },
      select: { status: true },
    });
    expect(untouched.status).toBe(AuditFindingStatus.OPEN);
  });
});

describe("figures a person might act on", () => {
  /**
   * An old invoice whose goods came back.
   *
   * The check asked whether `totalAmount > paidAmount` and totalled the
   * difference, which is what settled meant before returns existed. A credit
   * note settles an invoice as surely as a receipt does, so an invoice fully
   * returned and credited still read as unpaid: counted among the invoices
   * owed for more than ninety days, added into the total, and eligible to be
   * named as the oldest — the auditor telling a shop to chase a customer for
   * goods that customer had already sent back.
   */
  it("does not chase an old invoice the goods came back on", async () => {
    const fixture = await createCompany();
    const invoice = await sell(fixture, {
      quantity: 10,
      rate: 100,
      date: daysBefore(1),
    });
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: invoice.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: invoice.id,
        returnDate: daysBefore(1),
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 10 }],
      },
    });

    const report = await runAudit({
      companyId: fixture.companyId,
      from: WINDOW.from,
      to: new Date(TODAY.getTime() + 200 * DAY),
    });

    expect(keysOf(report)).not.toContain("LONG_OVERDUE_RECEIVABLE");
  }, 90_000);

  /**
   * A customer who paid without saying which invoice it was for.
   *
   * The same shape as the credit-note case above, from the other direction.
   * An unallocated receipt credits the receivable account, so the ledger knows
   * the debt is gone; `paidAmount` on the invoice does not move, because the
   * customer named no invoice for it to move against.
   *
   * The check reads `totalAmount - paidAmount - credited`, so it would tell a
   * shop to chase somebody whose money is already in the bank — the same
   * accusation the credit-note fix removed, made about a payment instead of a
   * return.
   */
  it("does not chase a customer who paid without naming an invoice", async () => {
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 100, date: daysBefore(1) });

    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "CUSTOMER",
        partyId: fixture.customerId,
        date: daysBefore(1),
        paymentMode: "CASH",
        amount: 1000,
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    // The receivable account is nil: they paid the lot.
    expect(
      Number(
        await accountBalance(
          fixture.companyId,
          SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
        ),
      ),
    ).toBe(0);

    const report = await runAudit({
      companyId: fixture.companyId,
      from: WINDOW.from,
      to: new Date(TODAY.getTime() + 200 * DAY),
    });
    expect(keysOf(report)).not.toContain("LONG_OVERDUE_RECEIVABLE");
  }, 90_000);

  it("counts only part of it as owed when part was paid on account", async () => {
    const fixture = await createCompany();
    await sell(fixture, { quantity: 10, rate: 100, date: daysBefore(1) });

    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "CUSTOMER",
        partyId: fixture.customerId,
        date: daysBefore(1),
        paymentMode: "CASH",
        amount: 400,
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    const report = await runAudit({
      companyId: fixture.companyId,
      from: WINDOW.from,
      to: new Date(TODAY.getTime() + 200 * DAY),
    });
    const overdue = report.findings.find(
      (entry) => entry.ruleKey === "LONG_OVERDUE_RECEIVABLE",
    );
    expect(overdue).toBeDefined();

    // The same standard the credit-note case is held to: what the auditor says
    // is owed is what the receivable account says is owed.
    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    expect(Number(overdue!.evidence.outstanding)).toBeCloseTo(
      Number(receivable),
      2,
    );
  }, 90_000);

  /**
   * A customer with an old debt and a recent one, who pays something.
   *
   * How much of a payment is unapplied is a fact about the whole account, so
   * it cannot be worked out from the overdue invoices alone. Measuring it
   * against only those makes the newer invoice look like unexplained balance
   * and swallows the credit whole: this customer's ₹300 would go nowhere and
   * the old debt would still read ₹1,000.
   *
   * Most customers have more than one invoice open, so this is the ordinary
   * case rather than the corner.
   */
  it("takes a payment off the old debt when a newer invoice is also open", async () => {
    const fixture = await createCompany();
    // Inside the first fiscal year, and far enough back that 30 days of
    // credit puts the due date well behind the ninety-day mark.
    await sell(fixture, { quantity: 10, rate: 100, date: daysBefore(140) });
    await sell(fixture, { quantity: 5, rate: 100, date: daysBefore(1) });

    await createReceipt({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "CUSTOMER",
        partyId: fixture.customerId,
        date: daysBefore(1),
        paymentMode: "CASH",
        amount: 300,
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    const report = await runAudit({
      companyId: fixture.companyId,
      from: WINDOW.from,
      to: WINDOW.to,
    });
    const overdue = report.findings.find(
      (entry) => entry.ruleKey === "LONG_OVERDUE_RECEIVABLE",
    );
    expect(overdue).toBeDefined();

    // ₹1,000 owed since long ago, less the ₹300 that came in against no
    // invoice in particular. The ₹500 raised yesterday is not overdue and is
    // not part of this figure.
    expect(Number(overdue!.evidence.outstanding)).toBeCloseTo(700, 2);
    expect(Number(overdue!.evidence.invoices)).toBe(1);
  }, 90_000);

  it("counts only what is still owed after a part of it came back", async () => {
    const fixture = await createCompany();
    const invoice = await sell(fixture, {
      quantity: 10,
      rate: 100,
      date: daysBefore(1),
    });
    const lines = await returnableLines({
      companyId: fixture.companyId,
      saleId: invoice.id,
    });

    await createSalesReturn({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      branchId: null,
      input: {
        saleId: invoice.id,
        returnDate: daysBefore(1),
        reason: "",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 4 }],
      },
    });

    const report = await runAudit({
      companyId: fixture.companyId,
      from: WINDOW.from,
      to: new Date(TODAY.getTime() + 200 * DAY),
    });
    const overdue = report.findings.find(
      (entry) => entry.ruleKey === "LONG_OVERDUE_RECEIVABLE",
    );
    expect(overdue).toBeDefined();

    // Against the receivable account, which is what the credit note moved and
    // what the ageing report and the receipt form both read.
    const receivable = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    expect(Number(overdue!.evidence.outstanding)).toBeCloseTo(
      Number(receivable),
      2,
    );
    expect(overdue!.evidence.invoices).toBe(1);
  }, 90_000);

  it("totals every overdue invoice, not the page of them it fetched", async () => {
    // The defect this replaces: the check took the first fifty overdue
    // invoices and added those up, then presented the result as the amount
    // outstanding. A shop with more than fifty saw a number that was wrong,
    // looked exact, and understated the problem more the worse it got.
    const fixture = await createCompany();

    const COUNT = 55;
    const RATE = 100;
    for (let index = 0; index < COUNT; index += 1) {
      await sell(fixture, { quantity: 1, rate: RATE, date: daysBefore(1) });
    }

    // Document numbering is provisioned per fiscal year, so invoices cannot be
    // dated a year back in a fresh company. The window is moved forward
    // instead: the check measures against the end of the audited period, so a
    // period ending well ahead makes yesterday's invoices long overdue —
    // which is the condition under test, reached from the other side.
    const report = await runAudit({
      companyId: fixture.companyId,
      from: WINDOW.from,
      to: new Date(TODAY.getTime() + 200 * DAY),
    });
    const overdue = report.findings.find(
      (entry) => entry.ruleKey === "LONG_OVERDUE_RECEIVABLE",
    );
    expect(overdue).toBeDefined();

    // Against the books rather than against a constant: whatever the tax rate
    // adds, the finding has to agree with what the invoices actually say.
    const owed = await prisma.sale.aggregate({
      where: { companyId: fixture.companyId, status: "POSTED" },
      _sum: { totalAmount: true, paidAmount: true },
      _count: true,
    });
    const expected =
      Number(owed._sum.totalAmount) - Number(owed._sum.paidAmount);

    expect(overdue!.evidence.invoices).toBe(COUNT);
    expect(Number(overdue!.evidence.outstanding)).toBeCloseTo(expected, 2);
    // The point of the fix: more than a page of invoices, and the total is not
    // the total of a page.
    expect(Number(overdue!.evidence.outstanding)).toBeGreaterThan(
      50 * RATE * 1.0,
    );
  }, 120_000);

  it("reports cash going negative only for days inside the audited period", async () => {
    // The balance still has to accumulate from the beginning of the books —
    // a drawer's position today is everything that ever went through it — but
    // a day outside the window is answering a question nobody asked, and it
    // would reappear on every run forever because the past does not change.
    const fixture = await createCompany();

    // Cash goes under on day 5 and is back above water by day 3.
    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "SUPPLIER",
        partyId: fixture.supplierId,
        date: daysBefore(5),
        paymentMode: "CASH",
        amount: 80_000, // more than the ₹20,000 opening balance
        referenceNo: "",
        notes: "",
        allocations: [],
      } satisfies PaymentInput,
    });
    await sell(fixture, {
      quantity: 2_000,
      rate: 100,
      date: daysBefore(3),
      paymentMode: "CASH",
    });

    const inside = await runAudit({ companyId: fixture.companyId, ...WINDOW });
    expect(keysOf(inside)).toContain("NEGATIVE_CASH_BALANCE");

    // The same books over a window that opens after the drawer recovered. The
    // balance still has to accumulate from the beginning — if it restarted at
    // the period opening this would report nil rather than the true position —
    // but no day inside the window closes below zero, so nothing is raised.
    const after = await runAudit({
      companyId: fixture.companyId,
      from: new Date(TODAY.getTime() - 2 * DAY),
      to: WINDOW.to,
    });
    expect(keysOf(after)).not.toContain("NEGATIVE_CASH_BALANCE");
  }, 60_000);
});

describe("when part of the sweep does not run", () => {
  it("keeps the incompleteness beside the score it qualifies", async () => {
    // This used to be computed, returned once and forgotten. Reopening the
    // page showed the same score with nothing to say that two of the checks
    // behind it had never run — a partial sweep reading as a clean one.
    const fixture = await createCompany();
    await audit(fixture);

    await prisma.auditRun.updateMany({
      where: { companyId: fixture.companyId },
      data: { incompleteChecks: ["gst", "stock"] },
    });

    const readBack = await getLatestAudit({ companyId: fixture.companyId });
    expect(readBack.run?.incomplete).toEqual(["gst", "stock"]);
    expect(readBack.run?.partial).toBe(true);
  });

  it("is not partial when every check ran", async () => {
    const fixture = await createCompany();
    const report = await audit(fixture);

    expect(report.run?.incomplete).toEqual([]);
    expect(report.run?.partial).toBe(false);
  });
});
