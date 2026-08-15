import { isZero, toDecimal, type Decimal } from "@/lib/money";

/**
 * Reading a bank statement CSV.
 *
 * Every Indian bank exports a different file and none of them agree on column
 * names, date order, or which column means money leaving. So this parser is
 * deliberately forgiving about *shape* and completely unforgiving about
 * *meaning*: a row it cannot read with certainty is reported as an error
 * against its line number rather than guessed at. A reconciliation built on a
 * guessed figure is worse than one that never ran.
 *
 * Nothing here calls a model. Reading a statement is parsing, and a language
 * model that quietly reads ₹1,04,522 as ₹104.522 would corrupt the books of
 * somebody who trusted it.
 */

/**
 * Direction, named from *our* books rather than the bank's.
 *
 * This is the single most confusable thing in the module, so it is stated once
 * and obeyed everywhere. A bank statement is written from the bank's point of
 * view: your deposit is money the bank now owes you, so the bank credits you,
 * and the column is headed "Credit" or "Deposit".
 *
 * In our books the bank account is an asset. Money arriving *increases* that
 * asset, which is a debit. So the bank's "Credit" column is our `IN`, and the
 * bank's "Debit"/"Withdrawal" column is our `OUT`.
 *
 * Storing the bank's own words would mean every later comparison against a
 * journal line had to remember to flip, and one place that forgot would produce
 * a reconciliation that balanced while being exactly wrong.
 */
export type StatementDirection = "IN" | "OUT";

export type ParsedStatementRow = {
  /** 1-based line number in the file, for reporting errors somebody can find. */
  lineNumber: number;
  txnDate: Date;
  valueDate: Date | null;
  description: string;
  referenceNo: string | null;
  direction: StatementDirection;
  /** Always positive. The direction carries the sign. */
  amount: Decimal;
  /** The bank's own running balance, when the file carries one. */
  runningBalance: Decimal | null;
};

export type StatementRowError = {
  lineNumber: number;
  message: string;
};

export type ParsedStatement = {
  rows: ParsedStatementRow[];
  errors: StatementRowError[];
};

export class StatementFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementFormatError";
  }
}

/**
 * Column synonyms, lower-cased and stripped of punctuation before matching.
 *
 * Ordered most specific first: "value date" must not be taken as the
 * transaction date just because it also contains "date".
 */
const HEADERS = {
  valueDate: ["value date", "valuedate", "value dt"],
  txnDate: [
    "transaction date",
    "txn date",
    "date",
    "posting date",
    "tran date",
    "dt",
  ],
  description: [
    "description",
    "narration",
    "particulars",
    "remarks",
    "transaction remarks",
    "details",
  ],
  reference: [
    "reference no",
    "reference number",
    "ref no",
    "cheque no",
    "chq no",
    "chq ref no",
    "cheque reference",
    "utr",
    "reference",
  ],
  withdrawal: [
    "withdrawal amt",
    "withdrawal amount",
    "withdrawal",
    "debit amount",
    "debit amt",
    "debit",
    "dr",
    "paid out",
  ],
  deposit: [
    "deposit amt",
    "deposit amount",
    "deposit",
    "credit amount",
    "credit amt",
    "credit",
    "cr",
    "paid in",
  ],
  amount: ["amount", "transaction amount", "amt"],
  drcr: ["type", "dr / cr", "dr/cr", "drcr", "indicator", "transaction type"],
  balance: ["balance", "closing balance", "running balance", "balance amt"],
} as const;

type ColumnMap = {
  txnDate: number;
  valueDate: number | null;
  description: number;
  reference: number | null;
  withdrawal: number | null;
  deposit: number | null;
  amount: number | null;
  drcr: number | null;
  balance: number | null;
};

function normaliseHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.()_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findColumn(
  headers: readonly string[],
  candidates: readonly string[],
  taken: ReadonlySet<number> = new Set(),
): number | null {
  const free = (index: number) => index !== -1 && !taken.has(index);

  // Exact match first, across every candidate, before falling back to a
  // contains match. Otherwise "date" would claim the "value date" column purely
  // because it appeared earlier in the file.
  for (const candidate of candidates) {
    const exact = headers.indexOf(candidate);
    if (free(exact)) return exact;
  }
  for (const candidate of candidates) {
    // Two-letter synonyms are exact-only. "dr" appears inside "dr/cr", so a
    // contains match let the Dr/Cr *indicator* column be read as the withdrawal
    // *amount* column — after which every row lost its amount and the file was
    // rejected wholesale.
    if (candidate.length <= 2) continue;
    const partial = headers.findIndex(
      (header, index) => free(index) && header.includes(candidate),
    );
    if (partial !== -1) return partial;
  }
  return null;
}

/**
 * A minimal RFC 4180 reader: quoted fields, doubled quotes, embedded newlines.
 *
 * Statement descriptions contain commas constantly ("NEFT DR-SBIN0001234-RAJESH
 * KUMAR, BANGALORE"), so splitting on commas would shift every column after the
 * description and silently read an amount out of the wrong cell.
 */
export function parseCsv(
  text: string,
  options: {
    /**
     * Keep rows that are entirely empty.
     *
     * A statement import wants them gone — a blank line between sections is
     * noise. An import that reports "row 6 is wrong" so somebody can open their
     * spreadsheet and go to row 6 needs them, because dropping them silently
     * shifts every line number after the first gap.
     */
    keepBlankRows?: boolean;
  } = {},
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
    started = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !started) {
      quoted = true;
      started = true;
    } else if (char === ",") {
      endField();
    } else if (char === "\r") {
      // Swallowed; the \n that follows ends the row. A lone \r ends it too.
      if (text[index + 1] !== "\n") endRow();
    } else if (char === "\n") {
      endRow();
    } else {
      field += char;
      started = true;
    }
  }

  // A file that does not end in a newline still has a last row.
  if (field.length > 0 || row.length > 0) endRow();

  if (options.keepBlankRows) return rows;
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ""));
}

/**
 * Indian statements write ₹1,04,522.50 with lakh grouping, sometimes with the
 * symbol attached, sometimes with a trailing Dr/Cr, sometimes parenthesised for
 * negative. All of that is stripped before the number is read.
 */
function parseAmount(raw: string): Decimal | null {
  const text = raw.trim();
  if (text === "" || text === "-") return null;

  const negative =
    /^\(.*\)$/.test(text) || /^\s*-/.test(text) || /-\s*$/.test(text);
  const cleaned = text
    .replace(/[()]/g, "")
    .replace(/(?:inr|rs\.?|₹)/gi, "")
    .replace(/\b(?:dr|cr)\b\.?/gi, "")
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .replace(/-/g, "");

  if (cleaned === "" || !/^\d*\.?\d+$/.test(cleaned)) return null;

  const value = toDecimal(cleaned);
  return negative ? value.negated() : value;
}

const DATE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  order: "dmy" | "ymd";
}> = [
  { pattern: /^(\d{4})-(\d{2})-(\d{2})$/, order: "ymd" },
  { pattern: /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/, order: "dmy" },
  { pattern: /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2})$/, order: "dmy" },
];

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Dates are read as day-first outside ISO form.
 *
 * Indian banks write 03/04/2026 meaning 3 April. Reading it as 4 March would
 * put a transaction in the wrong month, and a reconciliation is a statement
 * about a month. There is no way to detect the intent from a single row, so the
 * convention is fixed and documented rather than inferred — and an
 * unambiguously ISO date is still read as ISO.
 */
export function parseStatementDate(raw: string): Date | null {
  const text = raw.trim();
  if (text === "") return null;

  const named = /^(\d{1,2})[\s\-/]([A-Za-z]{3,})[\s\-/](\d{2,4})$/.exec(text);
  if (named) {
    const month = MONTHS[named[2]!.slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    const year = Number(named[3]);
    return utcDate(year < 100 ? 2000 + year : year, month, Number(named[1]));
  }

  for (const { pattern, order } of DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (order === "ymd") {
      return utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    const year = Number(match[3]);
    return utcDate(
      year < 100 ? 2000 + year : year,
      Number(match[2]),
      Number(match[1]),
    );
  }
  return null;
}

function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February rather than letting it roll into March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function cell(row: readonly string[], index: number | null): string {
  if (index === null) return "";
  return (row[index] ?? "").trim();
}

/**
 * How many values a row really carries.
 *
 * Trailing empty cells are ignored: plenty of exports pad every row to a fixed
 * width, and that is not the same fault as a stray comma mid-row.
 */
function widthOf(row: readonly string[]): number {
  let width = row.length;
  while (width > 0 && (row[width - 1] ?? "").trim() === "") width -= 1;
  return width;
}

/**
 * Parses a statement export into rows, plus the rows it could not read.
 *
 * Errors are returned rather than thrown so an import can show "4,318 rows
 * read, 2 skipped, here is which" — a statement with one malformed line is
 * still worth importing, and refusing the whole file would send somebody to
 * edit a CSV by hand.
 */
export function parseBankStatement(text: string): ParsedStatement {
  const table = parseCsv(text);
  if (table.length === 0) {
    throw new StatementFormatError("That file has no rows in it.");
  }

  const headerRow = table[0]!.map(normaliseHeader);

  // The Dr/Cr indicator is claimed first and then held back from every later
  // search. It is the column most likely to be confused for an amount — it is
  // literally headed "Dr/Cr" — and a column can only mean one thing.
  const taken = new Set<number>();
  const claim = (index: number | null): number | null => {
    if (index !== null) taken.add(index);
    return index;
  };

  const drcr = claim(findColumn(headerRow, HEADERS.drcr, taken));
  const valueDate = claim(findColumn(headerRow, HEADERS.valueDate, taken));
  const columns: ColumnMap = {
    drcr,
    valueDate,
    txnDate: claim(findColumn(headerRow, HEADERS.txnDate, taken)) ?? -1,
    description: claim(findColumn(headerRow, HEADERS.description, taken)) ?? -1,
    reference: claim(findColumn(headerRow, HEADERS.reference, taken)),
    balance: claim(findColumn(headerRow, HEADERS.balance, taken)),
    withdrawal: claim(findColumn(headerRow, HEADERS.withdrawal, taken)),
    deposit: claim(findColumn(headerRow, HEADERS.deposit, taken)),
    amount: claim(findColumn(headerRow, HEADERS.amount, taken)),
  };

  // Some exports carry only a value date. Since it is claimed first, the
  // transaction-date search finds nothing — so fall back to it rather than
  // rejecting a file that plainly has a date in it.
  if (columns.txnDate === -1 && columns.valueDate !== null) {
    columns.txnDate = columns.valueDate;
    columns.valueDate = null;
  }

  // Paired columns win outright.
  //
  // "Withdrawal Amt" contains "amt", so the single-amount synonym list matches
  // it too, and the naive fix — dropping whichever column collided — threw away
  // the *paired* column and left the file being read as single-amount with no
  // indicator. Every withdrawal then read as money in: a statement parsed
  // exactly backwards, which balances to a figure out by twice the total.
  //
  // A file that names withdrawals and deposits separately is unambiguous, so it
  // is preferred whenever it is present and the amount column is ignored.
  if (columns.withdrawal !== null || columns.deposit !== null) {
    columns.amount = null;
  }

  if (columns.txnDate === -1) {
    throw new StatementFormatError(
      "No date column found. Expected a column headed Date, Transaction Date or Value Date.",
    );
  }
  if (columns.description === -1) {
    throw new StatementFormatError(
      "No description column found. Expected Description, Narration or Particulars.",
    );
  }

  const hasPairedColumns =
    columns.withdrawal !== null || columns.deposit !== null;
  const hasSingleColumn = columns.amount !== null;
  if (!hasPairedColumns && !hasSingleColumn) {
    throw new StatementFormatError(
      "No amount columns found. Expected Withdrawal and Deposit, or a single Amount column.",
    );
  }

  const rows: ParsedStatementRow[] = [];
  const errors: StatementRowError[] = [];

  for (let index = 1; index < table.length; index += 1) {
    const raw = table[index]!;
    const lineNumber = index + 1;

    // A row wider than the header means the file has unquoted commas in it —
    // a lakh-grouped "1,25,000.00" written without quotes is the usual cause.
    // Every column after that point has shifted, so the amount would be read
    // out of the wrong cell. Refusing beats reading a plausible wrong figure.
    if (widthOf(raw) > headerRow.length) {
      errors.push({
        lineNumber,
        message:
          `This row has ${widthOf(raw)} values where the header has ` +
          `${headerRow.length}. Numbers containing commas need to be quoted in the file.`,
      });
      continue;
    }

    const txnDate = parseStatementDate(cell(raw, columns.txnDate));
    if (!txnDate) {
      errors.push({
        lineNumber,
        message: `Could not read the date "${cell(raw, columns.txnDate)}".`,
      });
      continue;
    }

    const description = cell(raw, columns.description);
    if (description === "") {
      errors.push({ lineNumber, message: "The description is empty." });
      continue;
    }

    const resolved = resolveDirection(raw, columns);
    if (resolved.kind === "unknown") {
      errors.push({
        lineNumber,
        message: "Could not tell whether this row is money in or money out.",
      });
      continue;
    }
    if (resolved.kind === "zero") {
      errors.push({
        lineNumber,
        message: "The amount is zero, so there is nothing to reconcile.",
      });
      continue;
    }

    const reference = cell(raw, columns.reference);
    rows.push({
      lineNumber,
      txnDate,
      valueDate: parseStatementDate(cell(raw, columns.valueDate)),
      description,
      referenceNo: reference === "" ? null : reference,
      direction: resolved.direction,
      amount: resolved.amount,
      runningBalance: parseAmount(cell(raw, columns.balance)),
    });
  }

  return { rows, errors };
}

/**
 * Which way the money went, from whichever shape the file uses.
 *
 * Paired columns are unambiguous. A single amount column is not: the sign or a
 * Dr/Cr indicator has to say, and where neither does the row is refused. A
 * statement line whose direction was assumed is a reconciliation that balances
 * to the wrong figure by twice the amount.
 */
type DirectionResult =
  | { kind: "ok"; direction: StatementDirection; amount: Decimal }
  /** Every amount on the row read as zero — a subtotal or a spacer line. */
  | { kind: "zero" }
  /** An amount, but nothing that says which way it went. */
  | { kind: "unknown" };

function resolveDirection(
  raw: readonly string[],
  columns: ColumnMap,
): DirectionResult {
  const withdrawal = parseAmount(cell(raw, columns.withdrawal));
  const deposit = parseAmount(cell(raw, columns.deposit));

  if (withdrawal !== null && !isZero(withdrawal)) {
    // The bank's withdrawal column is money leaving us.
    return { kind: "ok", direction: "OUT", amount: withdrawal.abs() };
  }
  if (deposit !== null && !isZero(deposit)) {
    return { kind: "ok", direction: "IN", amount: deposit.abs() };
  }

  const amount = parseAmount(cell(raw, columns.amount));
  if (amount === null) {
    // Paired columns were present and both read as zero. That is a different
    // complaint from "no amount at all", and saying so is the difference
    // between somebody finding the row and somebody re-exporting the file.
    return withdrawal !== null || deposit !== null
      ? { kind: "zero" }
      : { kind: "unknown" };
  }
  if (isZero(amount)) return { kind: "zero" };

  const indicator = cell(raw, columns.drcr).toLowerCase();
  if (indicator !== "") {
    // The indicator is the bank's own vocabulary: it debits your account when
    // money leaves it.
    if (/^d(r|ebit|b)?\b|withdraw|paid out/.test(indicator)) {
      return { kind: "ok", direction: "OUT", amount: amount.abs() };
    }
    if (/^c(r|redit)?\b|deposit|paid in/.test(indicator)) {
      return { kind: "ok", direction: "IN", amount: amount.abs() };
    }
    return { kind: "unknown" };
  }

  if (amount.isNegative()) {
    return { kind: "ok", direction: "OUT", amount: amount.abs() };
  }
  return { kind: "ok", direction: "IN", amount };
}
