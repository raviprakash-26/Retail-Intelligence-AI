import "server-only";
import { FiscalPeriodStatus } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import { fiscalYearRange } from "@/lib/constants/india";
import {
  FISCAL_YEAR_SERIES,
  SEQUENCE_PADDING,
  seriesPrefix,
} from "@/lib/documents/sequences";
import { FiscalDateOutOfRangeError } from "@/server/fiscal/errors";

/**
 * Keeping a tenant's calendar ahead of it.
 *
 * Provisioning gives a new company one fiscal year and its twelve periods, and
 * for a long time nothing ever gave it another — `fiscalYear.create` appeared
 * in exactly one file in the codebase. That is fine until the year ends: from
 * the first day of the next one no period covers today, and a shop cannot
 * raise an invoice, record a bill, log an expense, take a receipt, pay a
 * supplier or run payroll, because every one of those posts an entry and every
 * entry needs a period. The failure was not even legible — the document number
 * is allocated before the entry is posted, so the first thing to break was the
 * numbering, and the shop was told `No document sequence "SALE" configured for
 * company …`.
 *
 * A fiscal year is not a decision anybody makes. Given the start month the
 * business chose at signup, next year's dates and its twelve periods follow
 * from the calendar — there is nothing to ask and nothing to fill in — which is
 * why this extends itself on use rather than waiting behind a button somebody
 * has to know to press on the right morning.
 *
 * What it will not do is open a year for any date at all: see
 * `FiscalDateOutOfRangeError`.
 */

export type FiscalYearRow = {
  id: string;
  label: string;
  startDate: Date;
  endDate: Date;
};

/**
 * A tenant dormant for longer than this is not a calendar to extend silently.
 * The bound also means an error in the arithmetic below cannot loop forever.
 */
const MAX_YEARS_OPENED_AT_ONCE = 25;

/**
 * Namespace for the per-company advisory lock taken while opening a year.
 *
 * The two-argument form takes a pair of 4-byte integers and occupies a
 * different space from the platform seed's single 8-byte key, so the two locks
 * cannot collide however the numbers are chosen.
 */
const FISCAL_CALENDAR_LOCK = 48_192_027;

/**
 * Creates one fiscal year, its twelve periods, and a counter for every
 * year-scoped document series.
 *
 * Shared with provisioning, so a company's first year and its tenth are built
 * the same way. A year created without its document series would be a year the
 * tenant cannot raise an invoice in.
 */
export async function createFiscalYear(
  tx: DbClient,
  params: {
    companyId: string;
    /** Any date inside the year to create. */
    anchor: Date;
    startMonth: number;
    isCurrent?: boolean;
  },
): Promise<FiscalYearRow> {
  const { companyId, startMonth } = params;
  const { start, end, label } = fiscalYearRange(
    middayUtc(params.anchor),
    startMonth,
  );

  const year = await tx.fiscalYear.create({
    data: {
      companyId,
      label,
      startDate: start,
      endDate: end,
      isCurrent: params.isCurrent ?? false,
    },
    select: { id: true },
  });

  // Twelve monthly periods. Closing a period locks its journal entries, which
  // is what makes a month-end close meaningful.
  await tx.fiscalPeriod.createMany({
    data: Array.from({ length: 12 }, (_, index) => {
      const periodStart = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1),
      );
      const periodEnd = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index + 1, 0),
      );
      return {
        companyId,
        fiscalYearId: year.id,
        periodNumber: index + 1,
        label: periodStart.toLocaleString("en-IN", {
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }),
        startDate: periodStart,
        endDate: periodEnd,
        status: FiscalPeriodStatus.OPEN,
      };
    }),
  });

  await tx.documentSequence.createMany({
    data: FISCAL_YEAR_SERIES.map((series) => ({
      companyId,
      fiscalYearId: year.id,
      key: series.key,
      // Carries the year, so a series that restarts each April still produces
      // a number unique to one document. See `seriesPrefix`.
      prefix: seriesPrefix(series.prefix, label),
      padding: SEQUENCE_PADDING,
      nextValue: 1,
    })),
  });

  return { id: year.id, label, startDate: start, endDate: end };
}

/**
 * The fiscal year containing `date`, opening it — and any year between — when
 * the calendar has not reached that far yet.
 *
 * Call this from write paths only. A report that resolves a year must not
 * create one: reading the books should not change them, and a dashboard opened
 * on the first of April would otherwise start the year before the business had
 * recorded anything in it.
 */
export async function ensureFiscalYearFor(
  tx: DbClient,
  params: { companyId: string; date: Date; asOf?: Date },
): Promise<FiscalYearRow> {
  const { companyId, date } = params;
  const asOf = params.asOf ?? new Date();

  const covering = await findYearCovering(tx, companyId, date);
  if (covering) return covering;

  // Two tills selling at nine on the first of April both find no year and both
  // open one; Postgres rejects the loser on `@@unique([companyId, label])`, and
  // a statement that fails inside a transaction aborts the whole thing — so
  // catching it here would not save the sale that was being posted. The lock
  // makes the second caller wait and then find the year the first one opened.
  //
  // Transaction-scoped for the reason the seed lock is: released by the commit
  // or the rollback, with no unlock to forget. Taken only when a year is
  // actually missing, which is once a year per tenant.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FISCAL_CALENDAR_LOCK}::int, hashtext(${companyId}))`;

  const openedMeanwhile = await findYearCovering(tx, companyId, date);
  if (openedMeanwhile) return openedMeanwhile;

  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { fiscalYearStartMonth: true },
  });
  if (!company) throw new Error(`No such company ${companyId}.`);

  const startMonth = company.fiscalYearStartMonth;
  const target = fiscalYearRange(middayUtc(date), startMonth);
  const currentYear = fiscalYearRange(asOf, startMonth);

  // A year that has not begun is refused rather than opened. Every date this
  // turns away is one the business could not have traded on.
  if (target.start.getTime() > currentYear.start.getTime()) {
    throw new FiscalDateOutOfRangeError(
      date,
      "FUTURE_YEAR",
      `${isoDay(date)} falls in ${target.label}, a fiscal year that has not started yet. The current year is ${currentYear.label}.`,
    );
  }

  const existing = await tx.fiscalYear.findMany({
    where: { companyId },
    select: { startDate: true },
    orderBy: { startDate: "asc" },
  });

  const earliest = existing[0];
  if (!earliest) {
    // Provisioning always creates the first year, so this is a broken tenant
    // rather than a date problem — and saying so beats opening a year that
    // guesses when the business started.
    throw new Error(
      `Company ${companyId} has no fiscal year. It was not provisioned correctly.`,
    );
  }

  // The books start when the business did. Opening a year before the first one
  // would accept entries dated before the opening balances they contradict.
  if (target.start.getTime() < earliest.startDate.getTime()) {
    throw new FiscalDateOutOfRangeError(
      date,
      "BEFORE_FIRST_YEAR",
      `${isoDay(date)} is before this business's first fiscal year, which begins ${isoDay(earliest.startDate)}.`,
    );
  }

  const known = new Set(existing.map((year) => year.startDate.getTime()));

  // Walk forward from the first year, opening every year that is missing up to
  // the target, so a business that stopped trading for two years comes back to
  // a calendar with no holes in it. Periods close in order, and a missing year
  // is a hole that ordering cannot step over.
  let anchor: Date = earliest.startDate;
  let reached = false;
  for (let step = 0; step < MAX_YEARS_OPENED_AT_ONCE; step += 1) {
    const range = fiscalYearRange(middayUtc(anchor), startMonth);

    if (!known.has(range.start.getTime())) {
      await createFiscalYear(tx, { companyId, anchor, startMonth });
    }

    if (range.start.getTime() === target.start.getTime()) {
      reached = true;
      break;
    }

    // One day past the end lands in the following year, whatever its length.
    anchor = new Date(range.end.getTime() + DAY_MS);
  }

  if (!reached) {
    throw new Error(
      `Opening the fiscal year containing ${isoDay(date)} for company ${companyId} would need more than ${MAX_YEARS_OPENED_AT_ONCE} years.`,
    );
  }

  await markCurrentYear(tx, companyId, asOf);

  const opened = await findYearCovering(tx, companyId, date);
  if (!opened) {
    throw new Error(
      `Opened the calendar up to ${isoDay(date)} for company ${companyId}, and no year covers it.`,
    );
  }
  return opened;
}

/**
 * Moves the `isCurrent` flag onto the year containing today.
 *
 * The flag decides which year a report defaults to, so leaving it on a year
 * that ended would open every screen on last year's figures. Only one row per
 * company may carry it — a partial unique index says so — hence clearing
 * before setting rather than one statement doing both.
 */
async function markCurrentYear(
  tx: DbClient,
  companyId: string,
  asOf: Date,
): Promise<void> {
  const today = await findYearCovering(tx, companyId, asOf);
  if (!today) return;

  const alreadyCurrent = await tx.fiscalYear.findFirst({
    where: { companyId, isCurrent: true },
    select: { id: true },
  });
  if (alreadyCurrent?.id === today.id) return;

  await tx.fiscalYear.updateMany({
    where: { companyId, isCurrent: true },
    data: { isCurrent: false },
  });
  await tx.fiscalYear.update({
    where: { id: today.id },
    data: { isCurrent: true },
  });
}

/**
 * The year covering a date.
 *
 * `startDate` and `endDate` are `@db.Date` — days, stored at midnight — and a
 * caller may hand this an afternoon timestamp. Prisma sends a date parameter
 * for a date column, so two in the afternoon on 31 March is still inside a year
 * ending 31 March; the integration suite pins that, because if it stopped being
 * true the calendar would decide the current year did not exist, every year, on
 * its last day.
 */
async function findYearCovering(
  tx: DbClient,
  companyId: string,
  date: Date,
): Promise<FiscalYearRow | null> {
  return tx.fiscalYear.findFirst({
    where: { companyId, startDate: { lte: date }, endDate: { gte: date } },
    select: { id: true, label: true, startDate: true, endDate: true },
  });
}

const DAY_MS = 86_400_000;

/**
 * Midday UTC on the same calendar day.
 *
 * `fiscalYearRange` reads the local month and year, and the dates here are
 * midnight UTC. West of Greenwich that is the previous evening, which for
 * 1 April is the previous fiscal year — so a server in a negative offset would
 * open the wrong year, or walk backwards forever looking for the right one.
 * Midday is the same calendar day at every real offset.
 */
function middayUtc(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      12,
      0,
      0,
    ),
  );
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
