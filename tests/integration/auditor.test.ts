import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditFindingStatus } from "@prisma/client";
import { accuses, RULES_VERSION } from "@/lib/auditor/rules";
import type { RegisterInput } from "@/lib/validation/auth";
import type {
  CustomerInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import type { PaymentInput } from "@/lib/validation/settlements";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { createPayment } from "@/server/settlements/settlement-service";
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
  options: { quantity: number; rate: number; date?: string },
) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: options.date ?? daysBefore(1),
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: options.quantity,
          rate: options.rate,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
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
