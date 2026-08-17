/**
 * Refusals from the fiscal calendar.
 *
 * These live here rather than beside `postJournalEntry` because the calendar
 * itself now raises them, and the posting module imports the calendar — the
 * two cannot import each other.
 */

export class PeriodClosedError extends Error {
  constructor(date: Date) {
    super(
      `The accounting period containing ${date.toISOString().slice(0, 10)} is closed. Post to an open period, or reopen it first.`,
    );
    this.name = "PeriodClosedError";
  }
}

export class NoFiscalPeriodError extends Error {
  constructor(date: Date, message?: string) {
    super(
      message ??
        `No fiscal period covers ${date.toISOString().slice(0, 10)}. Create the fiscal year before posting to it.`,
    );
    this.name = "NoFiscalPeriodError";
  }
}

/**
 * A date the calendar will not open a fiscal year for.
 *
 * The calendar extends itself as time passes, so the year a document needs
 * normally exists by the time anybody asks for it. What it will not do is
 * invent a year to fit a date that should not have been entered: a mistyped
 * `2035` would otherwise silently create a fiscal year, twelve periods and a
 * set of document series nobody asked for, and the invoice that caused it
 * would sit nine years into the future where no report will ever show it.
 *
 * It extends `NoFiscalPeriodError` because that is what it is — no period
 * covers the date — which also means every action that already reports that
 * refusal reports this one, with its own message.
 */
export class FiscalDateOutOfRangeError extends NoFiscalPeriodError {
  constructor(
    date: Date,
    readonly code: "BEFORE_FIRST_YEAR" | "FUTURE_YEAR",
    message: string,
  ) {
    super(date, message);
    this.name = "FiscalDateOutOfRangeError";
  }
}
