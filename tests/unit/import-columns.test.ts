import { describe, expect, it } from "vitest";
import {
  mapColumns,
  parseBoolean,
  parseNumber,
  shapeRow,
} from "@/lib/import/columns";
import { DATASETS } from "@/lib/import/datasets";

/**
 * Reading somebody else's spreadsheet.
 *
 * The file a shop actually sends is not the file the template asks for. It has
 * "Item Code" where the template says SKU, rupee signs in the price column,
 * lakh grouping, a blank line where somebody pressed enter, and a column of
 * notes nobody asked for. None of that should stop an import, and none of it
 * should be guessed at either.
 */

const products = DATASETS.products.fields;

describe("matching headings a person actually wrote", () => {
  it("takes the obvious ones", () => {
    const map = mapColumns(["SKU", "Name", "Unit"], products);
    expect(map.found.sku).toBe(0);
    expect(map.found.name).toBe(1);
    expect(map.found.unit).toBe(2);
    expect(map.missing).toEqual([]);
  });

  it("takes the ones from another product", () => {
    // What Tally and a dozen spreadsheets actually call these.
    const map = mapColumns(
      ["Item Code", "Product Name", "UOM", "Cost Price", "Selling Price"],
      products,
    );
    expect(map.found.sku).toBe(0);
    expect(map.found.name).toBe(1);
    expect(map.found.unit).toBe(2);
    expect(map.found.purchasePrice).toBe(3);
    expect(map.found.sellingPrice).toBe(4);
  });

  it("ignores case, spacing and punctuation in a heading", () => {
    const map = mapColumns(["  item_code ", "PRODUCT-NAME", "u.o.m"], products);
    expect(map.found.sku).toBe(0);
    expect(map.found.name).toBe(1);
    expect(map.found.unit).toBe(2);
  });

  it("does not give one column to two fields", () => {
    // "Price" could be the selling price or the purchase price. Whichever
    // claims it, the other must not claim it too and silently duplicate.
    const map = mapColumns(["SKU", "Name", "Unit", "Price"], products);
    const claimed = Object.values(map.found);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("prefers an exact heading over a loose one, whichever field asked first", () => {
    // A file with both. "Purchase Price" must not be swallowed by the field
    // that merely contains "price".
    const map = mapColumns(
      ["SKU", "Name", "Unit", "Selling Price", "Purchase Price"],
      products,
    );
    expect(map.found.sellingPrice).toBe(3);
    expect(map.found.purchasePrice).toBe(4);
  });

  it("says which required heading is missing rather than guessing one", () => {
    const map = mapColumns(["Name", "Category"], products);
    expect(map.missing).toContain("sku");
    expect(map.missing).toContain("unit");
  });

  it("keeps the columns nothing claimed, so the page can say so", () => {
    const map = mapColumns(["SKU", "Name", "Unit", "Supplier Notes"], products);
    expect(map.unused).toEqual(["Supplier Notes"]);
  });

  it("never matches a two-letter synonym loosely", () => {
    // "id" lives inside "void" and "paid". A column filled from the wrong
    // heading is worse than one reported missing.
    const map = mapColumns(
      ["Paid", "Avoided"],
      [{ key: "id", synonyms: ["id"], required: true }],
    );
    expect(map.missing).toEqual(["id"]);
  });
});

describe("reading a cell somebody typed", () => {
  it("reads a price with a rupee sign and lakh grouping", () => {
    expect(parseNumber("₹1,04,522.50")).toBe(104522.5);
    expect(parseNumber("1,110")).toBe(1110);
    expect(parseNumber(" 240 ")).toBe(240);
    expect(parseNumber("500/-")).toBe(500);
  });

  it("reads a bracketed figure as negative, the way a ledger writes it", () => {
    expect(parseNumber("(2,500)")).toBe(-2500);
    expect(parseNumber("-750")).toBe(-750);
  });

  it("returns nothing for a blank, which is not the same as zero", () => {
    // A missing price and a price of nothing are different claims, and the
    // caller is the one that knows which its field means.
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("   ")).toBeNull();
  });

  it("refuses text rather than reading part of it as a number", () => {
    expect(parseNumber("n/a")).toBeNull();
    expect(parseNumber("12 pieces")).toBeNull();
    expect(parseNumber("--")).toBeNull();
  });

  it("reads yes and no the several ways people write them", () => {
    expect(parseBoolean("Yes")).toBe(true);
    expect(parseBoolean("Y")).toBe(true);
    expect(parseBoolean("TRUE")).toBe(true);
    expect(parseBoolean("no")).toBe(false);
    expect(parseBoolean("0")).toBe(false);
  });

  it("returns nothing for a word it does not know", () => {
    // "maybe" should stop the row, not quietly become "no".
    expect(parseBoolean("maybe")).toBeNull();
    expect(parseBoolean("")).toBeNull();
  });
});

describe("shaping a row", () => {
  it("names the cells and trims them", () => {
    const map = mapColumns(["SKU", "Name", "Unit"], products);
    expect(shapeRow([" RICE-5KG ", "Rice 5kg", "PCS"], map)).toEqual({
      sku: "RICE-5KG",
      name: "Rice 5kg",
      unit: "PCS",
    });
  });

  it("gives an empty string for a column the file does not have", () => {
    const map = mapColumns(["SKU", "Name", "Unit"], products);
    expect(shapeRow(["A", "B"], map).unit).toBe("");
  });
});

describe("the templates a person downloads", () => {
  it("uses headings the matcher actually recognises", () => {
    // A template whose own headings do not match would be a cruel joke.
    for (const dataset of Object.values(DATASETS)) {
      const header = (dataset.template[0] ?? "").split(",");
      const map = mapColumns(header, dataset.fields);
      expect(map.missing, `${dataset.key} template`).toEqual([]);
    }
  });

  it("carries example rows, not just a header", () => {
    for (const dataset of Object.values(DATASETS)) {
      expect(dataset.template.length).toBeGreaterThan(1);
    }
  });
});
