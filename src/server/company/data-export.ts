import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { csvLine } from "@/lib/reports/csv";
import {
  EXPORTED_MODELS,
  WITHHELD_MODELS,
  companyScopedModels,
  exportedFields,
  fileNameFor,
  unclassifiedModels,
  type ModelField,
} from "@/lib/export/manifest";

/**
 * A business's own books, on the way out of the door.
 *
 * **Every query is scoped to one company, and the scope is not a parameter the
 * caller can widen.** `where: { companyId }` is applied here to every table,
 * from a company id the route took off the session. There is no "all
 * companies" path, no flag that removes the filter, and no place a second
 * tenant's id could be substituted — the same rule the rest of the platform
 * runs on, applied at the one point where getting it wrong would hand somebody
 * a complete copy of another shop's ledger.
 *
 * **Rows are read in pages and written as they are read.** A shop with fifty
 * thousand invoices must not be a shop that cannot export, and building the
 * whole archive in memory first is how that happens. Nothing here holds more
 * than one page of one table.
 *
 * **Columns come from the manifest, never from `SELECT *`.** Prisma's default
 * selection returns every scalar column of a table, and a few company-scoped
 * tables hold session tokens and reset hashes. The manifest decides what is
 * read; this module only obeys it.
 */

/** Rows fetched per query. Large enough to be few round trips, small enough to hold. */
const PAGE_SIZE = 500;

/**
 * The narrow slice of a Prisma delegate this module uses.
 *
 * The model is chosen at runtime from the manifest, so the client is reached
 * by name. Typed to exactly the one call rather than cast to `any`, so a change
 * in the query shape is still a compile error.
 */
type ExportDelegate = {
  findMany(args: {
    where: { companyId: string };
    select: Record<string, true>;
    orderBy: { id: "asc" };
    take: number;
    skip?: number;
    cursor?: { id: string };
  }): Promise<Array<Record<string, unknown>>>;
};

function delegateFor(model: string): ExportDelegate | null {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  const client = prisma as unknown as Record<
    string,
    ExportDelegate | undefined
  >;
  const delegate = client[key];
  return delegate && typeof delegate.findMany === "function" ? delegate : null;
}

/**
 * One value, as it should read in a spreadsheet.
 *
 * Decimals are written from the decimal itself and never through a float, so
 * the value in the file is exactly the value in the ledger — an export is the
 * copy somebody keeps, and a rounding introduced here would be a rounding they
 * keep too. Dates go out in ISO so they sort and parse the same everywhere.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * One table, as CSV lines.
 *
 * An async generator so the caller can write each chunk into the archive and
 * let it go. `csvLine` escapes the fields and neutralises anything a
 * spreadsheet would otherwise execute as a formula — a customer named
 * `=cmd|...` is a real thing, and an export is exactly where it would land in
 * somebody else's Excel.
 */
export async function* tableAsCsv(
  model: string,
  fields: readonly ModelField[],
  companyId: string,
): AsyncGenerator<string> {
  const delegate = delegateFor(model);
  if (!delegate) return;

  const select: Record<string, true> = {};
  for (const field of fields) select[field.name] = true;

  yield `${csvLine(fields.map((field) => field.name))}\n`;

  let cursor: string | undefined;
  for (;;) {
    const rows = await delegate.findMany({
      where: { companyId },
      select,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) return;

    let chunk = "";
    for (const row of rows) {
      chunk += `${csvLine(fields.map((field) => cell(row[field.name])))}\n`;
    }
    yield chunk;

    if (rows.length < PAGE_SIZE) return;
    const last = rows[rows.length - 1];
    const id = last?.id;
    if (typeof id !== "string") return;
    cursor = id;
  }
}

export type ExportTable = { model: string; file: string; fields: ModelField[] };

/** The tables this export will write, in the order a reader should meet them. */
export function exportPlan(): ExportTable[] {
  const byName = new Map(companyScopedModels().map((m) => [m.name, m]));

  return EXPORTED_MODELS.flatMap((name) => {
    const model = byName.get(name);
    if (!model) return [];
    return [
      { model: name, file: fileNameFor(name), fields: exportedFields(model) },
    ];
  });
}

/**
 * The note that travels with the files.
 *
 * It says what is in the archive, what is not, and why — because a person
 * migrating onto another product will otherwise assume the zip is everything
 * and find out during the migration that it was not. It also says plainly that
 * these are the figures as recorded, not a statutory return.
 */
export function manifestText(params: {
  businessName: string;
  generatedAt: Date;
  tables: readonly ExportTable[];
}): string {
  const withheld = Object.entries(WITHHELD_MODELS)
    .map(([model, reason]) => `  ${fileNameFor(model).padEnd(28)} ${reason}`)
    .join("\n");

  const included = params.tables
    .map((table) => `  ${table.file.padEnd(28)} ${table.fields.length} columns`)
    .join("\n");

  return `Data export for ${params.businessName}
Taken on ${params.generatedAt.toISOString()}

This is a complete copy of this business's records as held by Retail
Intelligence AI, one CSV per table, in UTF-8 with a byte-order mark so that
Excel reads the rupee sign correctly.

These are the figures as recorded. Nothing here has been filed with any
authority, and an export is not a statutory return.

Included
${included}

Deliberately not included
${withheld}

Sign-in credentials are never exported, in any file.

Amounts are exact — nothing here has been rounded. Dates are ISO 8601, UTC.
Rows reference each other by the id columns, which are the same ids used
inside the application.
`;
}

/**
 * A guard against the schema growing a table nobody classified.
 *
 * Called before an export runs, so the failure is a refused download with a
 * plain reason rather than a silently incomplete archive. The test suite
 * asserts the same thing, which is where it should normally be caught; this is
 * the second line, for a deployment running a schema the tests never saw.
 */
export function unclassifiedTableNames(): string[] {
  return unclassifiedModels();
}
