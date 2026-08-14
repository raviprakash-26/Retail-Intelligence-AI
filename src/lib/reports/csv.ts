import type { ReportResult } from "@/lib/reports/result";

/**
 * A report, as a file a spreadsheet will open.
 *
 * Two separate jobs, and conflating them is how exports go wrong.
 *
 * The first is CSV quoting (RFC 4180): a field containing a comma, a quote or a
 * newline is wrapped in quotes and its own quotes doubled. Without it a product
 * called "Rice, 25kg" silently becomes two columns and every figure to its
 * right shifts one place.
 *
 * The second is that a spreadsheet is not a viewer — it is an interpreter. A
 * cell whose text begins `=`, `+`, `@` or a control character is evaluated as a
 * formula when the file is opened, and the text came from whatever somebody
 * typed into a product name. That is a way to reach the machine of the
 * accountant who opens the export, which is a more serious thing than a
 * misaligned column, and quoting does not prevent it: Excel evaluates the
 * contents of a quoted field just the same.
 *
 * So a leading formula character is defused with an apostrophe, which
 * spreadsheets read as "this is text". The exception is a figure that is merely
 * negative — `-472.0000` begins with a dangerous character and is not remotely
 * dangerous, and mangling every negative number in the ledger to guard against
 * a formula nobody wrote would be its own kind of wrong.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const MUST_QUOTE = /[",\r\n]|^\s|\s$/;

/** Stops a spreadsheet treating a value as a formula. */
export function neutraliseFormula(value: string): string {
  if (!FORMULA_LEAD.test(value)) return value;
  // A negative number is not a formula, and every ledger is full of them.
  if (PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}

export function csvField(value: string): string {
  const safe = neutraliseFormula(value);
  return MUST_QUOTE.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvLine(values: readonly string[]): string {
  return values.map(csvField).join(",");
}

/**
 * The whole report as CSV text.
 *
 * The title, the period and the notes are written into the file rather than
 * left on the page. A file that says only "1,04,522.00" with no statement of
 * what period it covers or that it is a preparation rather than a filing is a
 * figure somebody will quote out of context — and the export is precisely the
 * copy that travels.
 *
 * `\r\n` throughout, which is what RFC 4180 specifies and what Excel expects.
 */
export function toCsv(report: ReportResult): string {
  const lines: string[] = [
    csvLine([report.title]),
    csvLine([report.period]),
    "",
    csvLine(report.columns.map((column) => column.label)),
  ];

  for (const entry of report.rows) {
    lines.push(
      csvLine(report.columns.map((column) => entry.cells[column.key] ?? "")),
    );
  }

  if (report.notes.length > 0) {
    lines.push("");
    for (const note of report.notes) lines.push(csvLine([note]));
  }

  return lines.join("\r\n");
}

/** `trial-balance-2026-08-14.csv` — sorts by name, says what it is. */
export function csvFilename(key: string, on: Date = new Date()): string {
  return `${key}-${on.toISOString().slice(0, 10)}.csv`;
}
