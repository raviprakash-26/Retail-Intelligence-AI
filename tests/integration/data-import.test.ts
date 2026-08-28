import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { resolveSupplyType } from "@/lib/tax/gst";
import {
  commitImport,
  previewImport,
  ImportError,
  MAX_ROWS,
} from "@/server/import/import-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Bringing a shop's spreadsheet in.
 *
 * Two things are being protected. Nothing may be written that somebody has not
 * been shown first — an import that fails at row 300 of 500, leaving a business
 * unable to say which half arrived, is worse than one that refuses to start.
 * And whatever does arrive has to arrive through the ordinary services, so a
 * product with opening stock posts the same balanced entry it would have posted
 * had somebody typed it into the form.
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
      businessName: `Import ${uniqueSlug("Mart")}`,
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

type Fixture = { companyId: string; userId: string };

async function createCompany(): Promise<Fixture> {
  const email = `import-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return { companyId: result.companyId, userId: result.userId };
}

const run = (
  fixture: Fixture,
  dataset: "products" | "customers" | "suppliers",
  text: string,
) =>
  commitImport({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: "owner@example.com",
    dataset,
    text,
  });

const look = (
  fixture: Fixture,
  dataset: "products" | "customers" | "suppliers",
  text: string,
) => previewImport({ companyId: fixture.companyId, dataset, text });

/** A file as a shop sends it: other people's headings, rupee signs, a gap. */
const MESSY_PRODUCTS = `Item Code,Product Name,UOM,HSN,GST Rate,Cost Price,Selling Price,Opening Stock,Supplier Notes
RICE-5KG,Sona Masoori Rice 5kg,PCS,1006,5,"₹240","₹285",40,from metro
OIL-1L,Sunflower Oil 1L,PCS,1512,5,"1,110","1,332",25,

TEA-250,Tea Leaves 250g,PCS,0902,5,95,120,,
`;

/** Plans created by the allowance cases below; see the note on `capProductsAt`. */
const createdPlans: string[] = [];

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const companyId of createdCompanies) {
    await purgeTestCompany(companyId).catch(() => undefined);
  }
  // After the companies, so no subscription still points at these.
  await prisma.subscriptionPlan.deleteMany({
    where: { id: { in: createdPlans } },
  });
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("looking before writing", () => {
  it("reads a file written to somebody else's headings", async () => {
    const fixture = await createCompany();
    const preview = await look(fixture, "products", MESSY_PRODUCTS);

    expect(preview.missingColumns).toEqual([]);
    expect(preview.counts.create).toBe(3);
    expect(preview.counts.error).toBe(0);
    expect(preview.ready).toBe(true);
    // Named, so somebody can see the column they thought they were importing
    // is not one this product keeps.
    expect(preview.unusedColumns).toEqual(["Supplier Notes"]);
  }, 60_000);

  it("writes nothing while it is only looking", async () => {
    const fixture = await createCompany();
    await look(fixture, "products", MESSY_PRODUCTS);

    const count = await prisma.product.count({
      where: { companyId: fixture.companyId },
    });
    expect(count).toBe(0);
  }, 60_000);

  it("names the row and the column when something is wrong", async () => {
    // The whole point of a preview: not "something failed" but "row 3, unit".
    const fixture = await createCompany();
    const preview = await look(
      fixture,
      "products",
      `SKU,Name,Unit\nA-1,Good row,PCS\nB-2,Bad row,CRATE\n`,
    );

    expect(preview.ready).toBe(false);
    expect(preview.counts.error).toBe(1);
    const issue = preview.issues[0];
    expect(issue?.row).toBe(3);
    expect(issue?.column).toBe("unit");
    expect(issue?.message).toContain("CRATE");
  }, 60_000);

  /**
   * A price somebody mistyped.
   *
   * `parseNumber` returns null for anything it cannot read, and every caller
   * turned that into nought — so a cost of "12O0", with a letter where a zero
   * belongs, became a product costing nothing. It imports cleanly, and from
   * then on every sale of that line shows a hundred per cent margin, the
   * auditor calls it sold below cost, and the stock is valued at nil.
   *
   * The principle is already written down one function away, about booleans:
   * "a column somebody filled with 'maybe' should stop the row, not quietly
   * become 'no'." A number is the same. Blank still means nought — that is a
   * person saying there is no figure, rather than a person getting one wrong.
   */
  it("stops a row whose number cannot be read, rather than calling it nought", async () => {
    const fixture = await createCompany();
    const preview = await look(
      fixture,
      "products",
      `SKU,Name,Unit,Cost Price\nA-1,Good row,PCS,240\nB-2,Typo row,PCS,12O0\n`,
    );

    expect(preview.ready).toBe(false);
    expect(preview.counts.error).toBe(1);
    const issue = preview.issues[0];
    expect(issue?.row).toBe(3);
    expect(issue?.column).toBe("purchasePrice");
    expect(issue?.message).toContain("12O0");
  }, 60_000);

  it("still reads a blank number as nought", async () => {
    // The other half, and the reason this cannot simply refuse every null: an
    // empty cell is a person saying there is no figure.
    const fixture = await createCompany();
    const preview = await look(
      fixture,
      "products",
      `SKU,Name,Unit,Cost Price\nA-1,No cost given,PCS,\n`,
    );

    expect(preview.ready).toBe(true);
    expect(preview.counts.error).toBe(0);
  }, 60_000);

  it("stops a customer whose opening balance cannot be read", async () => {
    // The one that matters most: an opening balance is not a figure stored on
    // a record, it posts a balanced entry against opening capital. Read as
    // nought, a debt the shop is owed disappears from the books entirely.
    const fixture = await createCompany();
    const preview = await look(
      fixture,
      "customers",
      `Name,State Code,Opening Balance\nSharma Store,29,12500\nAnand Stores,29,1O500\n`,
    );

    expect(preview.ready).toBe(false);
    expect(preview.counts.error).toBe(1);
    expect(preview.issues[0]?.column).toBe("openingBalance");
  }, 60_000);

  it("counts the row a person would see, not the row after the blank line", async () => {
    // A spreadsheet with a gap in it still has to report the line somebody can
    // open the file and go to. Dropping blanks before numbering silently
    // shifts every row after the first gap.
    const fixture = await createCompany();
    const preview = await look(
      fixture,
      "products",
      `SKU,Name,Unit\nA-1,First,PCS\n\nB-2,Bad,CRATE\n`,
    );

    expect(preview.issues[0]?.row).toBe(4);
  }, 60_000);

  it("refuses a file with no column for something it needs", async () => {
    const fixture = await createCompany();
    const preview = await look(fixture, "products", `Name,Price\nRice,240\n`);

    expect(preview.missingColumns).toContain("sku");
    expect(preview.missingColumns).toContain("unit");
    expect(preview.ready).toBe(false);
  }, 60_000);

  it("will not commit a file that still has a bad row", async () => {
    const fixture = await createCompany();
    await expect(
      run(fixture, "products", `SKU,Name,Unit\nA-1,Good,PCS\nB-2,Bad,CRATE\n`),
    ).rejects.toBeInstanceOf(ImportError);

    expect(
      await prisma.product.count({ where: { companyId: fixture.companyId } }),
    ).toBe(0);
  }, 60_000);
});

describe("what arrives", () => {
  it("creates the rows and posts their opening stock through the ledger", async () => {
    // The rule the whole module rests on: no second path that writes stock
    // without writing the entry behind it.
    const fixture = await createCompany();
    const before = await prisma.journalEntry.count({
      where: { companyId: fixture.companyId },
    });

    const result = await run(fixture, "products", MESSY_PRODUCTS);
    expect(result.created).toBe(3);
    expect(result.failed).toEqual([]);

    const after = await prisma.journalEntry.count({
      where: { companyId: fixture.companyId },
    });
    // Two of the three carry opening stock; the third has none.
    expect(after - before).toBe(2);

    const trial = await getTrialBalance({
      companyId: fixture.companyId,
      to: "2027-03-31",
    });
    expect(trial.balanced).toBe(true);
  }, 120_000);

  it("keeps the figures the file gave it", async () => {
    const fixture = await createCompany();
    await run(fixture, "products", MESSY_PRODUCTS);

    const rice = await prisma.product.findFirstOrThrow({
      where: { companyId: fixture.companyId, sku: "RICE-5KG" },
      select: { name: true, purchasePrice: true, sellingPrice: true },
    });
    expect(rice.name).toBe("Sona Masoori Rice 5kg");
    // ₹240 and ₹285 with the sign and the grouping read off.
    expect(Number(rice.purchasePrice)).toBe(240);
    expect(Number(rice.sellingPrice)).toBe(285);

    const oil = await prisma.product.findFirstOrThrow({
      where: { companyId: fixture.companyId, sku: "OIL-1L" },
      select: { purchasePrice: true },
    });
    expect(Number(oil.purchasePrice)).toBe(1110);
  }, 120_000);

  it("brings in customers with what they owed on the day the books start", async () => {
    const fixture = await createCompany();
    const result = await run(
      fixture,
      "customers",
      `Name,Phone,City,State Code,Credit Days,Opening Balance\nSharma Provision Store,9845012345,Bengaluru,29,30,"12,500"\nAnand General Stores,9845098765,Mysuru,29,15,0\n`,
    );

    expect(result.created).toBe(2);
    const trial = await getTrialBalance({
      companyId: fixture.companyId,
      to: "2027-03-31",
    });
    // An opening balance is a balanced entry, not a number beside a name.
    expect(trial.balanced).toBe(true);

    const sharma = await prisma.customer.findFirstOrThrow({
      where: { companyId: fixture.companyId, name: "Sharma Provision Store" },
      select: { openingBalance: true },
    });
    expect(Number(sharma.openingBalance)).toBe(12500);
  }, 120_000);
});

describe("running it twice", () => {
  it("skips what is already here rather than duplicating it", async () => {
    // An import interrupted at row 300 has to be re-runnable. Anything else
    // means a shop with two of every product and no way to tell which.
    const fixture = await createCompany();

    const first = await run(fixture, "products", MESSY_PRODUCTS);
    expect(first.created).toBe(3);

    const second = await run(fixture, "products", MESSY_PRODUCTS);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(3);

    expect(
      await prisma.product.count({ where: { companyId: fixture.companyId } }),
    ).toBe(3);
  }, 120_000);

  it("skips a code the file repeats inside itself", async () => {
    // Otherwise the first creates, the second fails on a unique index, and the
    // import stops halfway with no explanation a person could act on.
    const fixture = await createCompany();
    const preview = await look(
      fixture,
      "products",
      `SKU,Name,Unit\nA-1,First,PCS\nA-1,Same code again,PCS\n`,
    );

    expect(preview.counts.create).toBe(1);
    expect(preview.counts.skip).toBe(1);
    expect(preview.rows[1]?.reason).toContain("twice");
  }, 60_000);
});

describe("one shop's file cannot reach another shop", () => {
  it("creates only in the company that asked", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    await run(mine, "products", MESSY_PRODUCTS);

    expect(
      await prisma.product.count({ where: { companyId: theirs.companyId } }),
    ).toBe(0);
    expect(
      await prisma.product.count({ where: { companyId: mine.companyId } }),
    ).toBe(3);
  }, 120_000);

  it("does not treat another company's codes as already here", async () => {
    // The skip check is scoped too. A product code used by a different shop
    // must not make this shop's row disappear.
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);

    await run(theirs, "products", MESSY_PRODUCTS);
    const preview = await look(mine, "products", MESSY_PRODUCTS);

    expect(preview.counts.create).toBe(3);
    expect(preview.counts.skip).toBe(0);
  }, 120_000);
});

describe("a file bigger than one sitting", () => {
  it("refuses more rows than the request can finish, with the number", async () => {
    // The failure this prevents: the reverse proxy closes the request at sixty
    // seconds, and a file long enough to cross that leaves rows created, no
    // report of which, and a person unable to tell what arrived. Refusing with
    // a number is the honest answer.
    const fixture = await createCompany();
    const rows = ["SKU,Name,Unit"];
    for (let i = 0; i < MAX_ROWS + 1; i += 1) {
      rows.push(`SKU-${i},Product ${i},PCS`);
    }

    await expect(look(fixture, "products", rows.join("\n"))).rejects.toThrow(
      new RegExp(String(MAX_ROWS)),
    );
  }, 60_000);

  it("brings in a file of a few hundred without losing any of them", async () => {
    // Small enough to run on every commit, large enough that a per-row mistake
    // — a cursor that does not advance, a skip set that never fills — would
    // show up as a wrong count rather than passing on three rows.
    const fixture = await createCompany();
    const N = 250;
    const rows = ["SKU,Name,Unit,Purchase Price,Selling Price,Opening Stock"];
    for (let i = 0; i < N; i += 1) {
      rows.push(
        `SKU-${i},Product number ${i},PCS,${100 + (i % 40)},${150 + (i % 40)},${i % 20}`,
      );
    }
    const file = rows.join("\n");

    const preview = await look(fixture, "products", file);
    expect(preview.counts.create).toBe(N);

    const result = await run(fixture, "products", file);
    expect(result.created).toBe(N);
    expect(result.failed).toEqual([]);

    expect(
      await prisma.product.count({ where: { companyId: fixture.companyId } }),
    ).toBe(N);

    // Every opening entry that was posted still balances against the others.
    const trial = await getTrialBalance({
      companyId: fixture.companyId,
      to: "2027-03-31",
    });
    expect(trial.balanced).toBe(true);
  }, 300_000);
});

/**
 * A file is subject to the plan, the same as a form is.
 *
 * Every module that writes asks `billingRefusal` before it does. This one did
 * not, so a subscription that had lapsed could still bring in four hundred
 * records at a time — "everything already recorded stays readable and
 * exportable" is what a read-only subscription promises, and writable was never
 * on that list. That half is guarded in the action, where every other module
 * guards it, and watched by `action-billing-coverage`.
 *
 * The allowance is the half that could not live there. `billingRefusal` asks
 * whether there is room for *one more*, which is the right question for a form
 * and the wrong one for a file: a shop with fifty slots left passes it and then
 * brings in four hundred products. Only the service knows how many rows are
 * about to be written, so the arithmetic is done there against the whole file.
 */
describe("a file against the plan's allowance", () => {
  /**
   * Puts the company on a plan of its own, so nothing else is disturbed.
   *
   * Removed again afterwards. Plans are platform-wide rather than tenant-owned,
   * so `purgeTestCompany` does not reach them: leaving them behind put a row
   * priced at nil in front of every other file's plan lookup, and the payments
   * suite started reporting that an upgrade cost nothing.
   */
  async function capProductsAt(companyId: string, allowed: number) {
    const plan = await prisma.subscriptionPlan.create({
      data: {
        key: `test-cap-${uniqueSlug("p")}`,
        name: "Test Cap",
        features: ["core.transactions"],
        limits: {
          users: -1,
          branches: -1,
          productsPerCompany: allowed,
          transactionsPerMonth: -1,
          aiMessagesPerMonth: -1,
          storageMb: -1,
        },
        isPublic: false,
      },
      select: { id: true },
    });
    createdPlans.push(plan.id);
    await prisma.subscription.update({
      where: { companyId },
      data: { planId: plan.id },
    });
  }

  const threeProducts = `sku,name,unitCode,sellingPrice
CAP-1,First,PCS,100
CAP-2,Second,PCS,100
CAP-3,Third,PCS,100
`;

  it("refuses a file that would take the shop past its allowance", async () => {
    const fixture = await createCompany();
    await capProductsAt(fixture.companyId, 2);

    await expect(run(fixture, "products", threeProducts)).rejects.toThrow(
      /plan allows 2/,
    );

    // Refused whole. A partial import leaves somebody guessing which rows
    // landed, and the row that did not is the one with the opening balance.
    const products = await prisma.product.count({
      where: { companyId: fixture.companyId },
    });
    expect(products).toBe(0);
  }, 90_000);

  it("brings in a file that fits exactly", async () => {
    const fixture = await createCompany();
    await capProductsAt(fixture.companyId, 3);

    const result = await run(fixture, "products", threeProducts);
    expect(result.created).toBe(3);
  }, 90_000);

  it("leaves an unlimited plan alone", async () => {
    const fixture = await createCompany();
    await capProductsAt(fixture.companyId, -1);

    const result = await run(fixture, "products", threeProducts);
    expect(result.created).toBe(3);
  }, 90_000);
});

/**
 * The state a spreadsheet gives back.
 *
 * The column is offered under the synonyms "state code" and "state", and the
 * value goes into the customer as typed: `stateCode: raw.stateCode ?? ""`,
 * checked only for length. Two digits or fewer passes.
 *
 * Excel renders 07 as the number 7 and writes it back to CSV that way. So a
 * Delhi shop importing its Delhi customers stores "7" against a company whose
 * own code is "07", and `resolveSupplyType` compares the two as strings: not
 * equal, so inter-state, so IGST on every invoice to that customer instead of
 * CGST and SGST.
 *
 * That is the wrong tax head rather than a wrong total. It goes on the invoice,
 * into the wrong table of GSTR-1, and the customer cannot match it in their own
 * GSTR-2B. Nothing about it is visible on the screen the shopkeeper is looking
 * at — the customer simply has a state, and it looks right.
 */
describe("the state a spreadsheet gives back", () => {
  it("reads a code the spreadsheet stripped the leading zero from", async () => {
    const fixture = await createCompany();
    await run(fixture, "customers", "Name,State\nSharma Provision Store,7\n");

    const customer = await prisma.customer.findFirstOrThrow({
      where: { companyId: fixture.companyId, name: "Sharma Provision Store" },
      select: { stateCode: true },
    });
    expect(customer.stateCode).toBe("07");
  }, 120_000);

  it("leaves a supply in the shop's own state intra-state", async () => {
    // The consequence, said the way the invoice says it. A Delhi shop and a
    // Delhi customer is CGST and SGST; the same pair with one side reading "7"
    // is IGST.
    const fixture = await createCompany();
    await run(fixture, "customers", "Name,State\nSharma Provision Store,7\n");

    const customer = await prisma.customer.findFirstOrThrow({
      where: { companyId: fixture.companyId, name: "Sharma Provision Store" },
      select: { stateCode: true },
    });
    expect(
      resolveSupplyType({
        registration: "REGULAR",
        sellerStateCode: "07",
        placeOfSupplyStateCode: customer.stateCode,
      }),
    ).toBe("INTRA_STATE");
  }, 120_000);

  it("reads a state written out by name", async () => {
    // "State" is one of the column's own synonyms, and a column headed State
    // usually holds a name. Two characters is not a name, so every such row
    // used to fail on a length rule that says nothing about states.
    const fixture = await createCompany();
    await run(
      fixture,
      "customers",
      "Name,State\nSharma Provision Store,Delhi\n",
    );

    const customer = await prisma.customer.findFirstOrThrow({
      where: { companyId: fixture.companyId, name: "Sharma Provision Store" },
      select: { stateCode: true },
    });
    expect(customer.stateCode).toBe("07");
  }, 120_000);

  it("refuses a state it cannot place, naming the column", async () => {
    // Loudly, rather than storing something that will quietly decide a tax
    // head later.
    const fixture = await createCompany();
    const preview = await look(
      fixture,
      "customers",
      "Name,State\nSharma Provision Store,ZZ\n",
    );

    expect(preview.issues).toHaveLength(1);
    expect(preview.issues[0]?.column).toBe("stateCode");
    expect(preview.issues[0]?.message).toMatch(/state/i);
  }, 120_000);
});
