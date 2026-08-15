import "server-only";
import { prisma } from "@/lib/db";
import { parseCsv } from "@/lib/banking/statement-parser";
import {
  mapColumns,
  parseNumber,
  shapeRow,
  type ColumnMap,
} from "@/lib/import/columns";
import { DATASETS, type DatasetKey } from "@/lib/import/datasets";
import {
  customerSchema,
  productSchema,
  supplierSchema,
} from "@/lib/validation/master-data";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";

/**
 * Bringing a business's existing records in.
 *
 * Every shop that moves onto this product arrives with a spreadsheet — from
 * Tally, from Excel, from whatever their last accountant used. Without this,
 * onboarding means typing several hundred products by hand, which is where a
 * trial dies. The export beside it makes leaving easy; this makes arriving
 * possible, and a product that only did the first would be an odd one.
 *
 * **Nothing is written until somebody has seen what would be written.** Every
 * import is checked first and reported row by row: what would be created, what
 * would be skipped because it is already here, and exactly which row and column
 * is wrong where something is. An import that fails halfway through five
 * hundred products, leaving a shop unable to tell which half arrived, is worse
 * than one that refuses to start.
 *
 * **The accounting is not reimplemented.** Rows go through the same
 * `createProduct` and `createParty` the forms use, so an opening stock quantity
 * posts the same balanced journal entry it would have posted had somebody typed
 * it in. There is no faster path that skips the ledger, because a faster path
 * that skips the ledger is how the books end up disagreeing with the masters.
 *
 * **Re-running is safe.** A row whose code or name already exists is skipped
 * rather than duplicated or overwritten, so an import interrupted at row 300
 * can simply be run again. Nothing here updates an existing record: quietly
 * changing a price somebody has since corrected, because it was still old in a
 * spreadsheet, is not something an import should do on its own.
 */

export type RowIssue = {
  /** 1-based, counting the header as row 1, so it matches what a person sees. */
  row: number;
  column: string | null;
  message: string;
};

export type RowPlan = {
  row: number;
  /** What identifies this row to a person reading the preview. */
  label: string;
  outcome: "create" | "skip" | "error";
  /** Why it would be skipped, where it would be. */
  reason?: string;
};

export type ImportPreview = {
  dataset: DatasetKey;
  /** Headings the file had that nothing claimed. */
  unusedColumns: string[];
  /** Required headings the file did not have. Nothing can run without these. */
  missingColumns: string[];
  rows: RowPlan[];
  issues: RowIssue[];
  counts: { create: number; skip: number; error: number };
  /** True where the file could be committed as it stands. */
  ready: boolean;
};

export type ImportResult = {
  created: number;
  skipped: number;
  failed: RowIssue[];
};

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/** More rows than this in one file and it should be split. */
export const MAX_ROWS = 5_000;

type Prepared = {
  row: number;
  label: string;
  input: Record<string, unknown>;
};

/** What a file would do, without doing any of it. */
export async function previewImport(params: {
  companyId: string;
  dataset: DatasetKey;
  text: string;
}): Promise<ImportPreview> {
  const { body, map } = await readFile(params);

  if (map.missing.length > 0) {
    return {
      dataset: params.dataset,
      unusedColumns: map.unused,
      missingColumns: map.missing,
      rows: [],
      issues: [],
      counts: { create: 0, skip: 0, error: 0 },
      ready: false,
    };
  }

  const { plans, issues } = await planRows({
    companyId: params.companyId,
    dataset: params.dataset,
    body,
    map,
  });

  const counts = {
    create: plans.filter((plan) => plan.outcome === "create").length,
    skip: plans.filter((plan) => plan.outcome === "skip").length,
    error: plans.filter((plan) => plan.outcome === "error").length,
  };

  return {
    dataset: params.dataset,
    unusedColumns: map.unused,
    missingColumns: [],
    rows: plans,
    issues,
    counts,
    // A file with one bad row is not committed. Fixing the row and uploading
    // again costs a minute; discovering later that row 194 never arrived costs
    // considerably more, and nothing in the books would say so.
    ready: counts.error === 0 && counts.create > 0,
  };
}

/**
 * Writes what the preview described.
 *
 * Row by row through the ordinary services rather than in one transaction:
 * each product posts its own opening entry, and a single transaction holding
 * five hundred of those would sit on locks for the length of the import. A row
 * that fails is reported and the rest continue, because the alternative is an
 * import that gets to row 400 and gives back nothing.
 */
export async function commitImport(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  dataset: DatasetKey;
  text: string;
}): Promise<ImportResult> {
  const { body, map } = await readFile(params);
  if (map.missing.length > 0) {
    throw new ImportError(
      `This file has no ${map.missing.join(", ")} column, so it cannot be brought in.`,
    );
  }

  const { plans, prepared } = await planRows({
    companyId: params.companyId,
    dataset: params.dataset,
    body,
    map,
  });

  if (plans.some((plan) => plan.outcome === "error")) {
    throw new ImportError(
      "This file still has rows with problems. Check it again before bringing it in.",
    );
  }

  const failed: RowIssue[] = [];
  let created = 0;

  for (const entry of prepared) {
    try {
      if (params.dataset === "products") {
        await createProduct({
          companyId: params.companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          input: entry.input as never,
        });
      } else {
        await createParty({
          companyId: params.companyId,
          kind: params.dataset === "customers" ? "CUSTOMER" : "SUPPLIER",
          userId: params.userId,
          actorEmail: params.actorEmail,
          input: entry.input as never,
        });
      }
      created += 1;
    } catch (error) {
      failed.push({
        row: entry.row,
        column: null,
        message:
          error instanceof Error
            ? error.message
            : "That row could not be brought in.",
      });
    }
  }

  return {
    created,
    skipped: plans.filter((plan) => plan.outcome === "skip").length,
    failed,
  };
}

// ---------------------------------------------------------------------------

/** A row of the file, with the line it came from. */
type NumberedRow = { line: number; cells: string[] };

async function readFile(params: {
  dataset: DatasetKey;
  text: string;
}): Promise<{ header: string[]; body: NumberedRow[]; map: ColumnMap }> {
  // A byte-order mark from Excel would otherwise become part of the first
  // heading, and "﻿SKU" matches nothing.
  const text = params.text.replace(/^﻿/, "");

  // Numbered before the blanks are dropped, not after. Every message this
  // module produces names a row so somebody can open the file and go to it —
  // and a spreadsheet with an empty line in the middle would otherwise be told
  // to look at row 5 for a problem sitting on row 6.
  const numbered: NumberedRow[] = parseCsv(text, {
    keepBlankRows: true,
  }).map((cells, index) => ({
    line: index + 1,
    cells,
  }));
  const filled = numbered.filter((row) =>
    row.cells.some((cell) => cell.trim() !== ""),
  );

  const first = filled[0];
  if (!first) throw new ImportError("That file has nothing in it.");
  if (filled.length - 1 > MAX_ROWS) {
    throw new ImportError(
      `That file has ${filled.length - 1} rows. Split it into files of ${MAX_ROWS} or fewer.`,
    );
  }

  return {
    header: first.cells,
    body: filled.slice(1),
    map: mapColumns(first.cells, DATASETS[params.dataset].fields),
  };
}

async function planRows(params: {
  companyId: string;
  dataset: DatasetKey;
  body: readonly NumberedRow[];
  map: ColumnMap;
}): Promise<{ plans: RowPlan[]; issues: RowIssue[]; prepared: Prepared[] }> {
  const { body } = params;
  const plans: RowPlan[] = [];
  const issues: RowIssue[] = [];
  const prepared: Prepared[] = [];

  const existing = await existingKeys(params.companyId, params.dataset);
  // A file that repeats a code inside itself would otherwise create the first
  // and fail the second on a unique index, halfway through.
  const seen = new Set<string>();

  const taxonomy =
    params.dataset === "products"
      ? await getProductTaxonomy(params.companyId)
      : null;

  for (const entry of body) {
    const rowNumber = entry.line;
    const raw = shapeRow(entry.cells, params.map);

    const built =
      params.dataset === "products"
        ? buildProduct(raw, taxonomy!)
        : buildParty(raw, params.dataset);

    if ("error" in built) {
      plans.push({
        row: rowNumber,
        label: raw.name || raw.sku || `Row ${rowNumber}`,
        outcome: "error",
      });
      issues.push({
        row: rowNumber,
        column: built.column,
        message: built.error,
      });
      continue;
    }

    const key = built.key.toLowerCase();
    const label = built.label;

    if (existing.has(key) || seen.has(key)) {
      plans.push({
        row: rowNumber,
        label,
        outcome: "skip",
        reason: existing.has(key)
          ? "already here"
          : "appears twice in this file",
      });
      continue;
    }

    seen.add(key);
    plans.push({ row: rowNumber, label, outcome: "create" });
    prepared.push({ row: rowNumber, label, input: built.input });
  }

  return { plans, issues, prepared };
}

/** Codes and names already in the books, so a re-run skips rather than fails. */
async function existingKeys(
  companyId: string,
  dataset: DatasetKey,
): Promise<Set<string>> {
  if (dataset === "products") {
    const rows = await prisma.product.findMany({
      where: { companyId },
      select: { sku: true },
    });
    return new Set(rows.map((row) => row.sku.toLowerCase()));
  }
  if (dataset === "customers") {
    const rows = await prisma.customer.findMany({
      where: { companyId },
      select: { name: true },
    });
    return new Set(rows.map((row) => row.name.toLowerCase()));
  }
  const rows = await prisma.supplier.findMany({
    where: { companyId },
    select: { name: true },
  });
  return new Set(rows.map((row) => row.name.toLowerCase()));
}

type Built =
  | { key: string; label: string; input: Record<string, unknown> }
  | { error: string; column: string | null };

function buildProduct(
  raw: Record<string, string>,
  taxonomy: NonNullable<Awaited<ReturnType<typeof getProductTaxonomy>>>,
): Built {
  // Names, not identifiers. A spreadsheet says "PCS" and "5%"; nothing in it
  // knows this installation's uuids.
  const unit = taxonomy.units.find(
    (option) =>
      option.code.toLowerCase() === raw.unit?.toLowerCase() ||
      option.name.toLowerCase() === raw.unit?.toLowerCase(),
  );
  if (!unit) {
    return {
      error: `There is no unit called "${raw.unit}". Add it under products first, or correct the spelling.`,
      column: "unit",
    };
  }

  const category = raw.category
    ? taxonomy.categories.find(
        (option) => option.name.toLowerCase() === raw.category?.toLowerCase(),
      )
    : undefined;
  if (raw.category && !category) {
    return {
      error: `There is no category called "${raw.category}". Add it first, or leave the column blank.`,
      column: "category",
    };
  }

  const wanted = raw.taxRate ? parseNumber(raw.taxRate) : null;
  const taxRate =
    wanted === null
      ? undefined
      : taxonomy.taxRates.find(
          (option) => Number(option.ratePercent) === wanted,
        );
  if (raw.taxRate && !taxRate) {
    return {
      error: `No tax rate of ${raw.taxRate} is set up for this business.`,
      column: "taxRate",
    };
  }

  const input = {
    sku: raw.sku ?? "",
    name: raw.name ?? "",
    description: raw.description ?? "",
    barcode: raw.barcode ?? "",
    hsnCode: raw.hsnCode ?? "",
    categoryId: category?.id ?? "",
    unitId: unit.id,
    taxRateId: taxRate?.id ?? "",
    purchasePrice: parseNumber(raw.purchasePrice ?? "") ?? 0,
    sellingPrice: parseNumber(raw.sellingPrice ?? "") ?? 0,
    mrp: parseNumber(raw.mrp ?? "") ?? 0,
    isStockTracked: true,
    openingQuantity: parseNumber(raw.openingQuantity ?? "") ?? 0,
    openingRate:
      parseNumber(raw.openingRate ?? "") ??
      parseNumber(raw.purchasePrice ?? "") ??
      0,
    minStockLevel: parseNumber(raw.minStockLevel ?? "") ?? 0,
  };

  const parsed = productSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  return { key: input.sku, label: `${input.sku} — ${input.name}`, input };
}

function buildParty(raw: Record<string, string>, dataset: DatasetKey): Built {
  const opening = parseNumber(raw.openingBalance ?? "") ?? 0;

  const input: Record<string, unknown> = {
    name: raw.name ?? "",
    phone: raw.phone ?? "",
    email: raw.email ?? "",
    gstin: (raw.gstin ?? "").toUpperCase(),
    pan: (raw.pan ?? "").toUpperCase(),
    addressLine1: raw.addressLine1 ?? "",
    city: raw.city ?? "",
    stateCode: raw.stateCode ?? "",
    pincode: raw.pincode ?? "",
    creditDays: parseNumber(raw.creditDays ?? "") ?? 0,
    // A negative opening is the other side of the ledger, which the form
    // expresses as a nature rather than a sign.
    openingBalance: Math.abs(opening),
    openingNature:
      dataset === "customers"
        ? opening < 0
          ? "CREDIT"
          : "DEBIT"
        : opening < 0
          ? "DEBIT"
          : "CREDIT",
    notes: "",
  };

  if (dataset === "customers") {
    input.creditLimit = parseNumber(raw.creditLimit ?? "") ?? 0;
  }

  const schema = dataset === "customers" ? customerSchema : supplierSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  return { key: String(input.name), label: String(input.name), input };
}

/** The first thing wrong, named by its column so somebody can go and fix it. */
function fromZod(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): Built {
  const first = error.issues[0];
  return {
    error: first?.message ?? "That row could not be read.",
    column: first?.path?.[0] ? String(first.path[0]) : null,
  };
}
