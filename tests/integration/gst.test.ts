import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type {
  CustomerInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import type { PurchaseInput } from "@/lib/validation/purchases";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import {
  createPurchaseReturn,
  returnableBillLines,
} from "@/server/returns/purchase-return-service";
import { createSale, voidSale } from "@/server/sales/sale-service";
import {
  getGstWorkingPaper,
  gstPeriods,
  periodLabel,
} from "@/server/gst/gst-return-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The GST working paper.
 *
 * What matters is that the figures come from the documents rather than being
 * re-derived, that the register agrees with the ledger, and that a void takes
 * its tax back out of the return. A return prepared from tax the books do not
 * support is the sort of thing a notice is issued about.
 */

const createdCompanies: string[] = [];
const createdEmails: string[] = [];
const PERIOD = { year: 2026, month: 6 };
const IN_PERIOD = "2026-06-15";

function registrationInput(email: string, stateCode = "29"): RegisterInput {
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
      businessName: "GST Test Mart",
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: stateCode === "29" ? "29AAAPR1234K1ZP" : "27AAAPR1234K1ZY",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode,
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
  registeredCustomerId: string;
  walkInCustomerId: string;
  supplierId: string;
};

async function createCompany(): Promise<Fixture> {
  const email = `gst-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
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
  const gst18 = taxonomy.taxRates.find((entry) => entry.code === "GST18");
  if (!unit || !gst18) throw new Error("Provisioning is incomplete");

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
      taxRateId: gst18.id,
      purchasePrice: 60,
      sellingPrice: 100,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 1000,
      openingRate: 60,
      minStockLevel: 0,
    } satisfies ProductInput,
  });

  const customerBase = {
    phone: "",
    email: "",
    pan: "",
    addressLine1: "",
    city: "",
    pincode: "",
    creditDays: 30,
    creditLimit: 1000000,
    openingBalance: 0,
    openingNature: "DEBIT" as const,
    notes: "",
  };

  const registered = await createParty({
    ...base,
    kind: "CUSTOMER",
    input: {
      ...customerBase,
      name: "Sharma Provision Store",
      gstin: "29AABCS1429B1ZX",
      stateCode: "29",
    } satisfies CustomerInput,
  });

  const walkIn = await createParty({
    ...base,
    kind: "CUSTOMER",
    input: {
      ...customerBase,
      name: "Lakshmi Kirana",
      gstin: "",
      stateCode: "",
    } satisfies CustomerInput,
  });

  const supplier = await createParty({
    ...base,
    kind: "SUPPLIER",
    input: {
      name: "Metro Wholesale",
      phone: "",
      email: "",
      gstin: "29AABCM4567N1Z8",
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
    registeredCustomerId: registered.id,
    walkInCustomerId: walkIn.id,
    supplierId: supplier.id,
  };
}

async function sell(
  fixture: Fixture,
  customerId: string,
  quantity: number,
  date = IN_PERIOD,
) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId,
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

async function buy(fixture: Fixture, quantity: number, claimCredit = true) {
  return createPurchase({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      supplierId: fixture.supplierId,
      supplierBillNo: uniqueSlug("SB").toUpperCase(),
      billDate: IN_PERIOD,
      paymentMode: "CREDIT",
      priceIncludesTax: false,
      claimInputCredit: claimCredit,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity,
          rate: 50,
          discountPercent: 0,
        },
      ],
    } satisfies PurchaseInput,
  });
}

/** Sends a whole bill back to the supplier, in the same period it was bought. */
async function returnWholeBill(fixture: Fixture, purchaseId: string) {
  const lines = await returnableBillLines({
    companyId: fixture.companyId,
    purchaseId,
  });
  return createPurchaseReturn({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      purchaseId,
      returnDate: IN_PERIOD,
      reason: "",
      refundMode: "CREDIT",
      lines: lines.map((line) => ({
        sourceLineId: line.lineId,
        quantity: Number(line.returnable),
      })),
    },
  });
}

const paperFor = (fixture: Fixture) =>
  getGstWorkingPaper({
    companyId: fixture.companyId,
    year: PERIOD.year,
    month: PERIOD.month,
  });

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

describe("outward supplies", () => {
  it("reads the tax off the invoices rather than recomputing it", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10); // ₹1,000 at 18%

    const paper = await paperFor(fixture);
    expect(paper.outward.total.taxableValue).toBe(toStorageString(1000));
    expect(paper.outward.total.cgst).toBe(toStorageString(90));
    expect(paper.outward.total.sgst).toBe(toStorageString(90));
    expect(paper.outward.total.totalTax).toBe(toStorageString(180));
  });

  it("separates registered customers from everyone else", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10);
    await sell(fixture, fixture.walkInCustomerId, 4);

    const paper = await paperFor(fixture);

    // B2B is by customer, because that is how GSTR-1 wants it.
    expect(paper.outward.b2b).toHaveLength(1);
    expect(paper.outward.b2b[0]?.partyGstin).toBe("29AABCS1429B1ZX");
    expect(paper.outward.b2bTotal.taxableValue).toBe(toStorageString(1000));

    // B2C is summarised by rate, because names are not reported.
    expect(paper.outward.b2cTotal.taxableValue).toBe(toStorageString(400));
    expect(paper.outward.b2cByRate).toHaveLength(1);
    expect(paper.outward.b2cByRate[0]?.ratePercent).toBe("18.00");
  });

  it("counts invoices, not register rows", async () => {
    // One invoice carrying several rates is one invoice; counting rows would
    // overstate every table on the return.
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 5);
    await sell(fixture, fixture.registeredCustomerId, 5);

    const paper = await paperFor(fixture);
    expect(paper.outward.b2b[0]?.documents).toBe(2);
    expect(paper.outward.total.documents).toBe(2);
  });

  it("summarises by HSN, as the return requires", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10);

    const paper = await paperFor(fixture);
    expect(paper.outward.byHsn).toHaveLength(1);
    expect(paper.outward.byHsn[0]?.hsnCode).toBe("1905");
    expect(paper.outward.byHsn[0]?.taxableValue).toBe(toStorageString(1000));
  });

  it("takes a voided invoice back out of the return", async () => {
    const fixture = await createCompany();
    const sale = await sell(fixture, fixture.registeredCustomerId, 10);
    await sell(fixture, fixture.walkInCustomerId, 4);

    const before = await paperFor(fixture);
    expect(before.outward.total.totalTax).toBe(toStorageString(252));

    await voidSale({
      companyId: fixture.companyId,
      saleId: sale.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Raised against the wrong customer",
    });

    const after = await paperFor(fixture);
    // Only the ₹400 walk-in sale is left.
    expect(after.outward.total.taxableValue).toBe(toStorageString(400));
    expect(after.outward.total.totalTax).toBe(toStorageString(72));
    expect(after.reconciliation.agrees).toBe(true);
  });

  it("counts only the period asked for", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10, "2026-06-15");
    await sell(fixture, fixture.registeredCustomerId, 20, "2026-07-15");

    const june = await paperFor(fixture);
    expect(june.outward.total.taxableValue).toBe(toStorageString(1000));

    const july = await getGstWorkingPaper({
      companyId: fixture.companyId,
      year: 2026,
      month: 7,
    });
    expect(july.outward.total.taxableValue).toBe(toStorageString(2000));
  });
});

describe("inward supplies and credit", () => {
  it("counts claimable credit separately from tax that is not", async () => {
    const fixture = await createCompany();
    await buy(fixture, 10, true); // ₹500 at 18% = ₹90, claimable
    await buy(fixture, 20, false); // ₹1,000 at 18% = ₹180, into the cost

    const paper = await paperFor(fixture);

    expect(paper.inward.eligible.totalTax).toBe(toStorageString(90));
    expect(paper.inward.ineligible.totalTax).toBe(toStorageString(180));
    // Only the claimable half is offered as credit.
    expect(paper.setOff.credit.cgst).toBe(toStorageString(45));
    expect(paper.setOff.credit.sgst).toBe(toStorageString(45));
  });

  it("lists suppliers, for comparing against what they filed", async () => {
    const fixture = await createCompany();
    await buy(fixture, 10);

    const paper = await paperFor(fixture);
    expect(paper.inward.bySupplier).toHaveLength(1);
    expect(paper.inward.bySupplier[0]?.partyName).toBe("Metro Wholesale");
    expect(paper.inward.bySupplier[0]?.partyGstin).toBe("29AABCM4567N1Z8");
  });
});

describe("what would be payable", () => {
  it("sets credit off against output tax and names what is left", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10); // ₹180 output
    await buy(fixture, 10); // ₹90 credit

    const paper = await paperFor(fixture);

    expect(paper.setOff.liability.cgst).toBe(toStorageString(90));
    expect(paper.setOff.credit.cgst).toBe(toStorageString(45));
    expect(paper.setOff.payable.cgst).toBe(toStorageString(45));
    expect(paper.setOff.payable.sgst).toBe(toStorageString(45));
    expect(paper.setOff.totalPayable).toBe(toStorageString(90));
    expect(paper.setOff.totalCarriedForward).toBe(toStorageString(0));
  });

  it("carries credit forward when it exceeds the tax owed", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 1); // ₹18 output
    await buy(fixture, 20); // ₹180 credit

    const paper = await paperFor(fixture);
    expect(paper.setOff.totalPayable).toBe(toStorageString(0));
    expect(paper.setOff.totalCarriedForward).toBe(toStorageString(162));
  });

  it("records each application of credit in order", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10);
    await buy(fixture, 10);

    const paper = await paperFor(fixture);
    expect(
      paper.setOff.steps.map((step) => `${step.from}->${step.against}`),
    ).toEqual(["cgst->cgst", "sgst->sgst"]);
  });

  it("owes the full output tax when nothing was bought", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10);

    const paper = await paperFor(fixture);
    expect(paper.setOff.totalPayable).toBe(toStorageString(180));
    expect(paper.setOff.steps).toEqual([]);
  });
});

describe("reconciling against the books", () => {
  it("agrees after sales and purchases", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10);
    await sell(fixture, fixture.walkInCustomerId, 4);
    await buy(fixture, 10);

    const paper = await paperFor(fixture);

    expect(paper.reconciliation.agrees).toBe(true);
    expect(paper.reconciliation.outputFromRegister).toBe(
      paper.reconciliation.outputFromLedger,
    );
    expect(paper.reconciliation.inputFromRegister).toBe(
      paper.reconciliation.inputFromLedger,
    );
  });

  it("agrees when tax was not claimable, because none was posted as an asset", async () => {
    const fixture = await createCompany();
    await buy(fixture, 10, false);

    const paper = await paperFor(fixture);
    expect(paper.inward.eligible.totalTax).toBe(toStorageString(0));
    expect(paper.reconciliation.inputFromLedger).toBe(toStorageString(0));
    expect(paper.reconciliation.agrees).toBe(true);
  });

  /**
   * Sending back a bill whose credit was never claimed.
   *
   * This is where the reconciliation could not help, and it is worth being
   * plain about why. The debit note used to credit input tax that had never
   * been claimed *and* stamp its register row as eligible — so the register and
   * the ledger moved by the same wrong amount in the same direction, the
   * difference between them stayed at zero, and `agrees` said yes. A check that
   * compares two figures cannot catch a mistake made identically in both.
   *
   * What it does catch is the money. A month's claimable credit is what the
   * set-off runs on, so surrendering a claim nobody made left less credit
   * against output tax and more payable in cash than was owed.
   */
  it("surrenders no credit when an unclaimed bill goes back", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10);
    const claimed = await buy(fixture, 10, true);
    const unclaimed = await buy(fixture, 20, false);

    const before = await paperFor(fixture);
    await returnWholeBill(fixture, unclaimed.id);
    const after = await paperFor(fixture);

    // The claimable credit is the one from the claimed bill, before and after.
    expect(before.inward.eligible.totalTax).toBe(toStorageString(90));
    expect(after.inward.eligible.totalTax).toBe(toStorageString(90));

    // So the set-off runs on the same credit and arrives at the same cash.
    expect(after.setOff.totalPayable).toBe(before.setOff.totalPayable);
    expect(after.reconciliation.agrees).toBe(true);
    expect(after.reconciliation.inputFromLedger).toBe(toStorageString(90));

    // And the unclaimable tax is still reported as what it is: a cost, not a
    // credit — reduced by the goods that went back.
    expect(after.inward.ineligible.totalTax).toBe(toStorageString(0));

    // Returning the claimed bill *does* give its credit up, which is the case
    // that must keep working for the guard above to mean anything.
    await returnWholeBill(fixture, claimed.id);
    const returned = await paperFor(fixture);
    expect(returned.inward.eligible.totalTax).toBe(toStorageString(0));
    expect(returned.reconciliation.agrees).toBe(true);
  });
});

describe("the framing", () => {
  it("reports the registration scheme so the page can qualify itself", async () => {
    const fixture = await createCompany();
    const paper = await paperFor(fixture);
    expect(paper.registration).toBe("REGULAR");
  });

  it("says a period is empty rather than printing zeroes", async () => {
    const fixture = await createCompany();
    const paper = await getGstWorkingPaper({
      companyId: fixture.companyId,
      year: 2020,
      month: 1,
    });

    expect(paper.empty).toBe(true);
    expect(paper.outward.total.totalTax).toBe(toStorageString(0));
    expect(paper.setOff.totalPayable).toBe(toStorageString(0));
  });

  it("offers only the periods that have activity", async () => {
    const fixture = await createCompany();
    await sell(fixture, fixture.registeredCustomerId, 10, "2026-06-15");
    await sell(fixture, fixture.registeredCustomerId, 10, "2026-08-15");

    const periods = await gstPeriods(fixture.companyId);
    expect(periods.map((period) => period.label)).toEqual([
      "August 2026",
      "June 2026",
    ]);
  });

  it("names a period in words", () => {
    expect(periodLabel(2026, 6)).toBe("June 2026");
    expect(periodLabel(2026, 12)).toBe("December 2026");
  });

  it("shows nobody else's tax", async () => {
    const alpha = await createCompany();
    const beta = await createCompany();
    await sell(beta, beta.registeredCustomerId, 50);
    await buy(beta, 30);

    const paper = await paperFor(alpha);
    expect(paper.empty).toBe(true);
    expect(paper.outward.total.totalTax).toBe(toStorageString(0));
    expect(paper.inward.eligible.totalTax).toBe(toStorageString(0));
  });
});
