import { describe, expect, it } from "vitest";
import {
  DENIED_FIELDS,
  EXPORTED_MODELS,
  WITHHELD_MODELS,
  companyScopedModels,
  exportedFields,
  fieldIsDenied,
  fileNameFor,
  unclassifiedModels,
} from "@/lib/export/manifest";

/**
 * What may leave in an export.
 *
 * Fifty-two tables carry a `companyId` and a few of them hold live session
 * tokens and password-reset hashes. Selecting every scalar column of every
 * scoped table would put all of that into a zip an owner can email, so the
 * classification here is the security boundary — and these are the tests that
 * keep it one as the schema grows.
 */

describe("every company-scoped table is classified", () => {
  it("leaves none of them undecided", () => {
    // The guard that makes this safe over time. A table added to the schema in
    // six months cannot join the export by default and cannot silently fall
    // out of it either — somebody has to write down which, and why.
    const orphans = unclassifiedModels();
    expect(
      orphans,
      `these company-scoped tables are in neither list: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("never puts a table in both lists", () => {
    const withheld = new Set(Object.keys(WITHHELD_MODELS));
    const both = EXPORTED_MODELS.filter((model) => withheld.has(model));
    expect(both).toEqual([]);
  });

  it("gives a reason for everything held back", () => {
    // Printed in the archive's own manifest, so a person migrating can see
    // what they did not get rather than discovering it mid-migration.
    for (const [model, reason] of Object.entries(WITHHELD_MODELS)) {
      expect(reason.length, `${model} has no reason`).toBeGreaterThan(20);
    }
  });

  it("names only tables that exist", () => {
    const real = new Set(companyScopedModels().map((model) => model.name));
    for (const name of [...EXPORTED_MODELS, ...Object.keys(WITHHELD_MODELS)]) {
      expect(real.has(name), `${name} is not a company-scoped model`).toBe(
        true,
      );
    }
  });
});

describe("credentials never leave", () => {
  it("holds back the tables that carry them", () => {
    expect(Object.keys(WITHHELD_MODELS)).toContain("Session");
    expect(Object.keys(WITHHELD_MODELS)).toContain("VerificationToken");
    expect(EXPORTED_MODELS).not.toContain("Session");
    expect(EXPORTED_MODELS).not.toContain("VerificationToken");
  });

  it("refuses a credential-shaped column wherever it appears", () => {
    // The second line rather than the first. Nothing in the exported set
    // should carry a secret, but a column added to an exported table later
    // might, and it should not need anybody to notice.
    expect(fieldIsDenied("tokenHash")).toBe(true);
    expect(fieldIsDenied("passwordHash")).toBe(true);
    expect(fieldIsDenied("webhookSecret")).toBe(true);
    expect(fieldIsDenied("resetTokenHash")).toBe(true);
    expect(fieldIsDenied("apiKey")).toBe(true);

    // And leaves ordinary columns alone.
    expect(fieldIsDenied("invoiceNumber")).toBe(false);
    expect(fieldIsDenied("totalAmount")).toBe(false);
  });

  it("lets no exported table keep a denied column", () => {
    const scoped = new Map(
      companyScopedModels().map((model) => [model.name, model]),
    );

    for (const name of EXPORTED_MODELS) {
      const model = scoped.get(name);
      if (!model) continue;
      for (const field of exportedFields(model)) {
        expect(
          fieldIsDenied(field.name),
          `${name}.${field.name} would have been exported`,
        ).toBe(false);
      }
    }
  });

  it("keeps the denylist matching on substrings, not whole names", () => {
    // `token` has to catch `resetTokenHash`; matching the whole name would
    // let every future variant through.
    expect(DENIED_FIELDS).toContain("token");
    expect(fieldIsDenied("someFutureTokenColumn")).toBe(true);
  });
});

describe("the files a person opens", () => {
  it("names them the way a spreadsheet user would expect", () => {
    expect(fileNameFor("Sale")).toBe("sale.csv");
    expect(fileNameFor("SaleItem")).toBe("sale_item.csv");
    expect(fileNameFor("JournalLine")).toBe("journal_line.csv");
    expect(fileNameFor("GstTransaction")).toBe("gst_transaction.csv");
  });

  it("gives every exported table a distinct file", () => {
    const files = EXPORTED_MODELS.map(fileNameFor);
    expect(new Set(files).size).toBe(files.length);
  });
});
