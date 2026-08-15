/**
 * Reading somebody else's spreadsheet.
 *
 * A shop arriving from Tally, from Excel, or from the software their nephew
 * wrote brings a file whose columns are named whatever the person who made it
 * felt like naming them. "SKU", "Item Code", "Product Code" and "code" are all
 * the same column; so are "Rate", "Selling Price" and "MRP" — except the last
 * one is not, which is why matching is a written-down list rather than a guess.
 *
 * This is the same problem the bank statement parser solved, and the same
 * approach: exact matches first, then longer synonyms as substrings, and a
 * column claimed once cannot be claimed again. Two-letter synonyms are never
 * matched loosely, because "id" appears inside "void" and "paid".
 *
 * Nothing here touches the database or decides whether a row is valid. It turns
 * a grid of strings into named fields, and says which columns it could not
 * find — so the page can tell somebody which heading to add before they wait
 * for a long import to fail.
 */

export type FieldSpec = {
  /** The name this becomes in the shaped row. */
  key: string;
  /** Headings that mean this field, most specific first. */
  synonyms: readonly string[];
  required?: boolean;
};

export type ColumnMap = {
  /** Field key to column index. */
  found: Record<string, number>;
  /** Required fields with no column, in the order they were declared. */
  missing: string[];
  /** Headings in the file that no field claimed. Kept for the preview. */
  unused: string[];
};

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The same heading with every separator gone.
 *
 * "u.o.m" and "uom" are one heading written two ways, and so are "GST IN" and
 * "gstin". Comparing both forms costs nothing and saves somebody renaming a
 * column to satisfy software.
 */
const squash = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Matches headings to fields, claiming each column at most once.
 *
 * Order matters twice over: every field gets its exact match before any field
 * gets a loose one, so a file with both "price" and "purchase price" does not
 * lose the second to whichever field asked first.
 */
export function mapColumns(
  headers: readonly string[],
  fields: readonly FieldSpec[],
): ColumnMap {
  const cleaned = headers.map(normalise);
  const taken = new Set<number>();
  const found: Record<string, number> = {};

  const claim = (key: string, index: number) => {
    found[key] = index;
    taken.add(index);
  };

  const squashed = headers.map(squash);

  for (const field of fields) {
    let done = false;
    for (const synonym of field.synonyms) {
      const at = cleaned.indexOf(normalise(synonym));
      if (at !== -1 && !taken.has(at)) {
        claim(field.key, at);
        done = true;
        break;
      }
    }
    if (done) continue;
    for (const synonym of field.synonyms) {
      const at = squashed.indexOf(squash(synonym));
      if (at !== -1 && !taken.has(at)) {
        claim(field.key, at);
        break;
      }
    }
  }

  for (const field of fields) {
    if (found[field.key] !== undefined) continue;
    for (const synonym of field.synonyms) {
      // Short synonyms are exact-only: "id" lives inside "void" and "paid",
      // and a wrong column silently filled is worse than a missing one.
      if (normalise(synonym).length <= 3) continue;
      const at = cleaned.findIndex(
        (header, index) =>
          !taken.has(index) && header.includes(normalise(synonym)),
      );
      if (at !== -1) {
        claim(field.key, at);
        break;
      }
    }
  }

  return {
    found,
    missing: fields
      .filter((field) => field.required && found[field.key] === undefined)
      .map((field) => field.key),
    unused: headers.filter((_, index) => !taken.has(index)),
  };
}

/** One row of the file, as named fields. Absent columns come back as "". */
export function shapeRow(
  row: readonly string[],
  map: ColumnMap,
): Record<string, string> {
  const shaped: Record<string, string> = {};
  for (const [key, index] of Object.entries(map.found)) {
    shaped[key] = (row[index] ?? "").trim();
  }
  return shaped;
}

/**
 * A number as a person typed it.
 *
 * Indian spreadsheets carry ₹, lakh grouping, and the occasional trailing
 * "/-". A blank is not zero — a missing price and a price of nothing are
 * different claims — so this returns null and lets the caller decide.
 */
export function parseNumber(raw: string): number | null {
  const cleaned = raw
    .replace(/[₹\s,]/g, "")
    .replace(/\/-$/, "")
    .trim();
  if (cleaned === "") return null;

  const negative = /^\(.*\)$/.test(cleaned);
  const body = negative ? cleaned.slice(1, -1) : cleaned;
  if (!/^-?\d*\.?\d+$/.test(body)) return null;

  const value = Number(body);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * Yes/no as a person typed it.
 *
 * Anything unrecognised is null rather than false: a column somebody filled
 * with "maybe" should stop the row, not quietly become "no".
 */
export function parseBoolean(raw: string): boolean | null {
  const value = normalise(raw);
  if (value === "") return null;
  if (["y", "yes", "true", "1", "t"].includes(value)) return true;
  if (["n", "no", "false", "0", "f"].includes(value)) return false;
  return null;
}
