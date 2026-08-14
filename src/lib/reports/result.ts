import type { ReportKey } from "@/lib/reports/catalogue";

/**
 * The one shape every report produces.
 *
 * Cells are strings, always, and they are the strings the source service
 * returned — money arrives as the 4dp storage form and is formatted for the
 * screen at render, never on the way in. That is what lets the CSV be the same
 * figures as the page rather than a second rendering of them, and it keeps
 * rounding out of a layer that has no business rounding anything.
 *
 * `notes` travels with the result into the export. A caveat that only appears
 * on screen is a caveat that is lost the moment somebody emails the file, and
 * the two things this product must never be read as — a filed return and a
 * regulated score — are exactly the things somebody would email.
 */

export type ReportColumnKind = "text" | "money" | "number" | "date";

export type ReportColumn = {
  key: string;
  label: string;
  kind: ReportColumnKind;
};

/**
 * How a row reads.
 *
 *   • `group` — a heading inside the body, e.g. an account group.
 *   • `total` — a subtotal or the closing figure.
 *   • `normal` — everything else.
 */
export type ReportRowEmphasis = "normal" | "group" | "total";

export type ReportRow = {
  cells: Record<string, string>;
  emphasis: ReportRowEmphasis;
};

export type ReportResult = {
  key: ReportKey;
  title: string;
  /** Rendered period, e.g. "1 Apr 2026 to 14 Aug 2026" or "as at 14 Aug 2026". */
  period: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Caveats that must travel with the figures, screen and file alike. */
  notes: string[];
  /** True when the source had nothing to report — distinct from an error. */
  empty: boolean;
};

export function row(
  cells: Record<string, string>,
  emphasis: ReportRowEmphasis = "normal",
): ReportRow {
  return { cells, emphasis };
}
