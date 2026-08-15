import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
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
