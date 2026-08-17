/**
 * Every numbered series a tenant keeps.
 *
 * This list is the single definition of what `allocateDocumentNumber` can be
 * asked for. Provisioning creates a row for each series when a company is
 * created, and the fiscal calendar creates a fresh row for each year-scoped
 * series when a new year opens — two places that must agree about the same set,
 * which is exactly the kind of knowledge that drifts when it is written twice.
 *
 * `allocateDocumentNumber` throws when a row is missing rather than inventing
 * one, because a series that quietly starts over is worse than a refusal: two
 * invoices would carry the same number.
 */

export type SequenceScope =
  /**
   * Restarts at 1 each fiscal year. Vouchers work this way because a document
   * series is read as belonging to a year, which is why the year is in the
   * number: `INV-2627-0001`. See `seriesPrefix`.
   */
  | "FISCAL_YEAR"
  /**
   * One running series for the life of the tenant. A customer is not a
   * document filed in a year; renumbering the master records every April would
   * hand two customers the same code.
   */
  | "COMPANY";

export type DocumentSeries = {
  key: string;
  prefix: string;
  scope: SequenceScope;
};

export const DOCUMENT_SERIES = [
  { key: "SALE", prefix: "INV-", scope: "FISCAL_YEAR" },
  { key: "SALES_RETURN", prefix: "SR-", scope: "FISCAL_YEAR" },
  { key: "PURCHASE", prefix: "BILL-", scope: "FISCAL_YEAR" },
  { key: "PURCHASE_RETURN", prefix: "PR-", scope: "FISCAL_YEAR" },
  { key: "EXPENSE", prefix: "EXP-", scope: "FISCAL_YEAR" },
  { key: "RECEIPT", prefix: "RCP-", scope: "FISCAL_YEAR" },
  { key: "PAYMENT", prefix: "PAY-", scope: "FISCAL_YEAR" },
  { key: "JOURNAL", prefix: "JV-", scope: "FISCAL_YEAR" },
  { key: "PAYROLL", prefix: "SAL-", scope: "FISCAL_YEAR" },
  { key: "CUSTOMER", prefix: "CUS-", scope: "COMPANY" },
  { key: "SUPPLIER", prefix: "SUP-", scope: "COMPANY" },
  { key: "EMPLOYEE", prefix: "EMP-", scope: "COMPANY" },
] as const satisfies readonly DocumentSeries[];

/**
 * The keys, as a type.
 *
 * `allocateDocumentNumber` takes this rather than a `string`, which is what
 * makes this list impossible to forget: a series added to a service and not to
 * the list above does not compile, so it can never reach a tenant that has no
 * counter for it. A test could look for the same mistake by reading the source
 * and matching call sites with a regular expression; the compiler does it
 * without being asked.
 */
export type DocumentSeriesKey = (typeof DOCUMENT_SERIES)[number]["key"];

/** Series that get a fresh counter when a fiscal year opens. */
export const FISCAL_YEAR_SERIES = DOCUMENT_SERIES.filter(
  (series) => series.scope === "FISCAL_YEAR",
);

/** Series that run for the life of the tenant, created once at provisioning. */
export const COMPANY_SERIES = DOCUMENT_SERIES.filter(
  (series) => series.scope === "COMPANY",
);

export const SEQUENCE_PADDING = 4;

/**
 * The prefix a year-scoped series uses, carrying the fiscal year it belongs to:
 * `INV-` in 2026-27 becomes `INV-2627-`, so the first invoice of that year is
 * `INV-2627-0001`.
 *
 * Two rules in this codebase were quietly incompatible, and nothing could
 * notice while every tenant had exactly one fiscal year. The series restart
 * each April — that is what `DocumentSequence.fiscalYearId` is for — while
 * every document number is unique per *company*: `@@unique([companyId,
 * invoiceNumber])`, and the same on bills, returns, vouchers and journal
 * entries. The first invoice of a tenant's second year would have been
 * `INV-0001` for the second time, and the insert would have failed on the
 * unique index with nothing to explain it.
 *
 * Both rules are worth keeping. A series that restarts each year is what an
 * Indian shop expects on an invoice, and a number that identifies exactly one
 * document is what makes "which invoice?" answerable — so the year goes into
 * the number, which is also how most shops write it by hand. It stays inside
 * Rule 46(b)'s sixteen characters.
 *
 * Series already issued keep their prefix. Renumbering an invoice somebody has
 * already been given is not a thing software may do.
 */
export function seriesPrefix(prefix: string, fiscalYearLabel: string): string {
  return `${prefix}${fiscalYearLabel.replace("-", "").slice(2)}-`;
}
