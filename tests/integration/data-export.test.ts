import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createSale } from "@/server/sales/sale-service";
import { exportArchiveStream } from "@/server/company/export-archive";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * A business taking its own books out.
 *
 * The point of the module is that a shop is not locked in. The risk of the
 * module is that a complete dump of every company-scoped table is exactly
 * where a tenant-isolation mistake would be worst — one bad `where` and a
 * shopkeeper downloads a competitor's customer list, prices and margins.
 *
 * So the central case here builds two businesses with deliberately findable
 * data in each, exports one, and reads every byte of the archive looking for
 * the other.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function registrationInput(email: string, businessName: string): RegisterInput {
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
      businessName,
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
  name: string;
  productName: string;
  customerName: string;
};

/** A shop whose every record carries a word unique to it. */
async function createShop(marker: string): Promise<Fixture> {
  const slug = uniqueSlug("x").replace(/-/g, "");
  const email = `export-${slug}@example.com`;
  createdEmails.push(email);

  const name = `${marker} Stores ${slug}`;
  const result = await registerOwner(registrationInput(email, name));
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

  const productName = `${marker}Widget`;
  const customerName = `${marker}Customer`;

  const product = await createProduct({
    ...base,
    input: {
      sku: `${marker}-SKU`,
      name: productName,
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
      openingQuantity: 500,
      openingRate: 60,
      minStockLevel: 0,
    } satisfies ProductInput,
  });

  const customer = await createParty({
    ...base,
    kind: "CUSTOMER",
    input: {
      name: customerName,
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

  await createSale({
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
    branchId: null,
    input: {
      customerId: customer.id,
      invoiceDate: new Date().toISOString().slice(0, 10),
      paymentMode: "CREDIT",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: product.id,
          description: "",
          quantity: 3,
          rate: 100,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });

  return {
    companyId: result.companyId,
    userId: result.userId,
    name,
    productName,
    customerName,
  };
}

/** The archive, unpacked, as filename → raw bytes. */
async function rawExportOf(
  fixture: Fixture,
): Promise<Record<string, Uint8Array>> {
  const stream = exportArchiveStream({
    companyId: fixture.companyId,
    businessName: fixture.name,
  });

  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }

  // Unpacked by a real zip reader, not by trusting what was written. An
  // archive nobody can open is not an export.
  return unzipSync(bytes);
}

/**
 * The same archive as text.
 *
 * Decoding strips the byte-order mark — `TextDecoder` drops a leading BOM
 * unless told otherwise — so the case that checks for one reads the raw bytes
 * instead. Everything else is easier to assert against as text.
 */
async function exportOf(fixture: Fixture): Promise<Record<string, string>> {
  const files = await rawExportOf(fixture);
  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, strFromU8(data)]),
  );
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

describe("one business's export contains only that business", () => {
  it("carries none of another shop's records, in any file", async () => {
    // The case the whole module has to survive. Both shops hold the same kinds
    // of record; only the marker words differ, so anything of Bravo's showing
    // up in Alpha's archive is a `where` clause that was not applied.
    const [alpha, bravo] = await Promise.all([
      createShop("Alpha"),
      createShop("Bravo"),
    ]);

    const archive = await exportOf(alpha);
    const everything = Object.values(archive).join("\n");

    expect(everything).toContain(alpha.productName);
    expect(everything).toContain(alpha.customerName);

    expect(everything).not.toContain(bravo.productName);
    expect(everything).not.toContain(bravo.customerName);
    expect(everything).not.toContain(bravo.companyId);
    expect(everything).not.toContain(bravo.name);
  }, 120_000);

  it("stamps every row with the company that asked", async () => {
    const fixture = await createShop("Charlie");
    const archive = await exportOf(fixture);

    // Every table carries companyId, and every value of it must be this one.
    for (const [file, text] of Object.entries(archive)) {
      if (file === "MANIFEST.txt") continue;
      const [header, ...rows] = text.replace(/^﻿/, "").split("\n");
      const columns = (header ?? "").split(",");
      const at = columns.indexOf("companyId");
      if (at === -1) continue;

      for (const row of rows.filter((line) => line.trim() !== "")) {
        const value = row.split(",")[at];
        expect(value, `${file} carries a row from another company`).toBe(
          fixture.companyId,
        );
      }
    }
  }, 120_000);
});

describe("what the archive is", () => {
  it("opens as a zip and leads with a manifest", async () => {
    const fixture = await createShop("Delta");
    const archive = await exportOf(fixture);

    expect(archive["MANIFEST.txt"]).toBeDefined();
    expect(archive["MANIFEST.txt"]).toContain(fixture.name);
    // The half people forget: what they did *not* get, and why.
    expect(archive["MANIFEST.txt"]).toContain("Deliberately not included");
    expect(archive["MANIFEST.txt"]).toContain("session.csv");
  }, 120_000);

  it("holds no credential from any table", async () => {
    const fixture = await createShop("Echo");
    const archive = await exportOf(fixture);
    const everything = Object.values(archive).join("\n");

    // The owner's password hash exists in the database at this moment; it must
    // not exist in the file they can email to anybody.
    const user = await prisma.user.findFirstOrThrow({
      where: { memberships: { some: { companyId: fixture.companyId } } },
      select: { passwordHash: true },
    });
    expect(user.passwordHash.length).toBeGreaterThan(20);

    expect(everything).not.toContain(user.passwordHash);
    expect(everything).not.toMatch(/\$2[aby]\$/);
    expect(archive["session.csv"]).toBeUndefined();
    expect(archive["verification_token.csv"]).toBeUndefined();
  }, 120_000);

  it("writes each file so a spreadsheet reads the rupee sign", async () => {
    // Read as bytes on purpose. Excel decides a CSV is UTF-8 from these three,
    // and without them ₹ arrives as mojibake on the Windows machines these are
    // opened on — the exact failure the report export already guards against.
    const fixture = await createShop("Foxtrot");
    const archive = await rawExportOf(fixture);

    for (const [file, bytes] of Object.entries(archive)) {
      if (file === "MANIFEST.txt") continue;
      expect(
        [bytes[0], bytes[1], bytes[2]],
        `${file} has no byte-order mark`,
      ).toEqual([0xef, 0xbb, 0xbf]);
    }
  }, 120_000);

  it("keeps amounts exact rather than rounding them on the way out", async () => {
    const fixture = await createShop("Golf");
    const archive = await exportOf(fixture);

    const lines = (archive["journal_line.csv"] ?? "")
      .replace(/^﻿/, "")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(1);

    // The sale was 3 × ₹100. Whatever the tax adds, the ledger's own figures
    // are what the file has to carry — checked against the database rather
    // than against a number written here.
    const posted = await prisma.journalLine.findMany({
      where: { companyId: fixture.companyId },
      select: { debit: true, credit: true },
    });
    const body = lines.slice(1).join("\n");
    for (const line of posted) {
      const amount = line.debit.toString();
      if (amount !== "0") expect(body).toContain(amount);
    }
  }, 120_000);
});

describe("a name a spreadsheet would run", () => {
  it("is neutralised before it reaches somebody's Excel", async () => {
    // A customer called `=cmd|...` is a real thing, and an export is exactly
    // where it lands in the accountant's spreadsheet rather than the shop's.
    const fixture = await createShop("Hotel");
    await prisma.customer.updateMany({
      where: { companyId: fixture.companyId },
      data: { name: "=cmd|' /c calc'!A1" },
    });

    const archive = await exportOf(fixture);
    const customers = archive["customer.csv"] ?? "";

    expect(customers).toContain("cmd|");
    // Quoted and led with an apostrophe, so Excel treats it as text.
    expect(customers).not.toMatch(/(^|,)=cmd/m);
    expect(customers).toContain("'=cmd");
  }, 120_000);
});
