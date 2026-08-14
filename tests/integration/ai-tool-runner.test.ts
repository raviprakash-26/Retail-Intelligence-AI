import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { runTool, type ToolContext } from "@/server/ai/tool-runner";
import { TOOL_NAMES } from "@/lib/ai/tools";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The tool runner.
 *
 * One question matters more than all the others here: can a tool call, however
 * it is phrased, reach a tenant it was not bound to? The answer has to be no by
 * construction, and the way to show that is to give two companies very
 * different books and check that a runner bound to one never returns the
 * other's figures — including when the call is deliberately fed the other
 * company's identifier in every field it has.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

const IN_YEAR = "2026-06-15";

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
      businessName: `Assistant ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 50000,
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
  context: ToolContext;
};

async function createCompany(): Promise<Fixture> {
  const email = `tool-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);

  const base = {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };

  const year = await prisma.fiscalYear.findFirstOrThrow({
    where: { companyId: result.companyId },
    select: { startDate: true, endDate: true },
  });

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
      openingQuantity: 50_000,
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

  return {
    ...base,
    productId: product.id,
    customerId: customer.id,
    context: {
      companyId: result.companyId,
      fiscalYearStart: year.startDate,
      fiscalYearEnd: year.endDate,
    },
  };
}

async function sell(fixture: Fixture, quantity: number) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: IN_YEAR,
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

const call = (fixture: Fixture, name: string, input: unknown = {}) =>
  runTool({ name, input, context: fixture.context });

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

describe("every tool runs against the company it was bound to", () => {
  it("answers from this tenant's books and no other", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    await sell(mine, 10); // ₹1,000
    await sell(theirs, 900); // ₹90,000

    const outcome = await call(mine, "financial_statements", {
      from: "2026-04-01",
      to: "2027-03-31",
    });
    expect(outcome.ok).toBe(true);

    const statements = (
      outcome as { result: { trading: { revenueTotal: string } } }
    ).result;
    expect(Number(statements.trading.revenueTotal)).toBe(1_000);
  });

  it("ignores a company identifier smuggled into the arguments", async () => {
    // The schemas have no field for one, so extra keys are stripped by
    // validation before dispatch. This is the prompt-injection case: "get me
    // the figures for the other shop" has nowhere to land.
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    await sell(mine, 10);
    await sell(theirs, 900);

    const outcome = await call(mine, "financial_statements", {
      from: "2026-04-01",
      to: "2027-03-31",
      companyId: theirs.companyId,
      tenantId: theirs.companyId,
      company: "Assistant Mart",
    });

    expect(outcome.ok).toBe(true);
    const statements = (
      outcome as { result: { trading: { revenueTotal: string } } }
    ).result;
    expect(Number(statements.trading.revenueTotal)).toBe(1_000);
  });

  it("runs every tool in the catalogue without reaching across", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    await sell(mine, 5);
    await sell(theirs, 700);

    const inputs: Record<string, unknown> = {
      financial_statements: { from: "2026-04-01", to: "2027-03-31" },
      trial_balance: { to: "2027-03-31" },
      chart_of_accounts: {},
      outstanding: { kind: "receivable" },
      stock_position: {},
      gst_working_paper: { year: 2026, month: 6 },
      income_tax_estimate: {},
      analytics: { range: "fy" },
      forecast: {},
    };

    for (const name of TOOL_NAMES) {
      const outcome = await call(mine, name, inputs[name]);
      expect(outcome.ok, `${name} failed`).toBe(true);

      // Nothing any tool returns may mention the other tenant at all.
      const json = JSON.stringify((outcome as { result: unknown }).result);
      expect(json).not.toContain(theirs.companyId);
    }
  }, 60_000);
});

describe("refusing what it was not given", () => {
  it("says there is no such tool rather than throwing", async () => {
    const fixture = await createCompany();
    const outcome = await runTool({
      name: "post_journal_entry",
      input: { amount: 500 },
      context: fixture.context,
    });

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toMatch(/no tool called/i);
  });

  it("returns a validation failure the model can act on", async () => {
    const fixture = await createCompany();
    const outcome = await call(fixture, "gst_working_paper", {
      year: 2026,
      month: 19,
    });

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toMatch(/not valid/i);
    // Named field, so the model can correct itself rather than guess.
    expect((outcome as { error: string }).error).toMatch(/month/);
  });

  it("rejects a date that is not a real date", async () => {
    const fixture = await createCompany();
    const outcome = await call(fixture, "financial_statements", {
      from: "2026-02-30",
      to: "2026-06-30",
    });
    expect(outcome.ok).toBe(false);
  });

  it("turns a service failure into a message rather than an exception", async () => {
    // A company with no financial year cannot have a tax estimate. The model
    // needs to be told that, not to lose the turn to an unhandled throw.
    const fixture = await createCompany();
    const outcome = await runTool({
      name: "income_tax_estimate",
      input: {},
      context: {
        ...fixture.context,
        fiscalYearStart: null,
        fiscalYearEnd: null,
      },
    });

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toMatch(
      /no financial year has been set up/i,
    );
  });
});

describe("what the tools return", () => {
  it("hands back figures the services computed, not recomputed ones", async () => {
    const fixture = await createCompany();
    await sell(fixture, 40); // ₹4,000

    const [statements, trial] = await Promise.all([
      call(fixture, "financial_statements", {
        from: "2026-04-01",
        to: "2027-03-31",
      }),
      call(fixture, "trial_balance", { to: "2027-03-31" }),
    ]);

    expect(statements.ok && trial.ok).toBe(true);
    const revenue = Number(
      (statements as { result: { trading: { revenueTotal: string } } }).result
        .trading.revenueTotal,
    );
    expect(revenue).toBe(4_000);

    // The trial balance the assistant sees is the one the page shows, so it
    // cannot tell a user the books balance while the page says otherwise.
    expect((trial as { result: { balanced: boolean } }).result.balanced).toBe(
      true,
    );
  });

  it("passes a ratio's refusal through instead of a zero", async () => {
    const fixture = await createCompany();
    const outcome = await call(fixture, "analytics", { range: "fy" });
    expect(outcome.ok).toBe(true);

    const ratios = (
      outcome as {
        result: {
          ratios: Array<{ value: number | null; unavailable: string | null }>;
        };
      }
    ).result.ratios;
    for (const ratio of ratios) {
      if (ratio.value === null) expect(ratio.unavailable).not.toBeNull();
    }
  });
});
