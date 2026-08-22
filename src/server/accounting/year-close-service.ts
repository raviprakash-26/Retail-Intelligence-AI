import "server-only";
import { FiscalPeriodStatus, JournalStatus, VoucherType } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  add,
  compare,
  isZero,
  money,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";
import { accountBalances } from "@/server/accounting/balances";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { recordAuditLog } from "@/server/audit/audit-log";

/**
 * Closing the year.
 *
 * Closing a *period* freezes a month. Closing a **year** is a different act: it
 * settles what the business earned. Income and expense accounts measure one
 * year and one year only, so at the end of it their balances are transferred to
 * retained earnings and they start the next year at nil. That transfer is the
 * closing entry, and until now this system did not write one.
 *
 * Everything needed for it was already here and unreachable, which is the tell.
 * `RETAINED_EARNINGS` sits in every company's chart of accounts with nothing
 * ever posted to it. `VoucherType.CLOSING_ENTRY` is in the schema, and both the
 * auditor and the income-tax computation already exclude it — they were written
 * to expect an entry nothing could produce. `FiscalYear.closedAt` is read by the
 * year selector, which draws a padlock beside a closed year, and was written by
 * nothing, so the padlock could never appear.
 *
 * **The balance sheet needs no special case, and that is by design.** It adds
 * everything earned up to the closing date into equity, because nothing had
 * closed the income accounts. Once this entry zeroes them, that figure becomes
 * nil of its own accord and retained earnings — an equity account — carries the
 * amount instead. The two arrangements produce the same equity total, which is
 * what makes the close safe to perform on books that have already been read.
 *
 * **Reopening is possible and noisy**, for the reason reopening a period is: a
 * mistake found after closing has to be correctable, and the correction has to
 * be visible to whoever finds it later.
 */

export class YearCloseError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "ALREADY"
      | "NOT_CLOSED"
      | "PERIODS_OPEN"
      | "ORDER"
      | "NO_RETAINED_EARNINGS",
  ) {
    super(message);
    this.name = "YearCloseError";
  }
}

export type YearCloseView = {
  id: string;
  label: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
  closedAt: Date | null;
  /** Periods inside it that are still open — what closing waits on. */
  openPeriods: string[];
  /** True when every period is closed and no earlier year is still open. */
  closable: boolean;
  /** The entry that closed it, for the page to link to. */
  closingEntry: { id: string; entryNumber: string } | null;
};

/** Every year, newest first, with what closing it would mean. */
export async function listYearsForClosing(
  companyId: string,
): Promise<YearCloseView[]> {
  const [years, periods, entries] = await Promise.all([
    prisma.fiscalYear.findMany({
      where: { companyId },
      select: {
        id: true,
        label: true,
        startDate: true,
        endDate: true,
        isCurrent: true,
        closedAt: true,
      },
      orderBy: { startDate: "desc" },
    }),
    prisma.fiscalPeriod.findMany({
      where: { companyId, status: { not: FiscalPeriodStatus.CLOSED } },
      select: { fiscalYearId: true, label: true, startDate: true },
      orderBy: { startDate: "asc" },
    }),
    prisma.journalEntry.findMany({
      where: {
        companyId,
        voucherType: VoucherType.CLOSING_ENTRY,
        status: JournalStatus.POSTED,
        reversesId: null,
      },
      select: { id: true, entryNumber: true, fiscalYearId: true },
    }),
  ]);

  const openByYear = new Map<string, string[]>();
  for (const period of periods) {
    openByYear.set(period.fiscalYearId, [
      ...(openByYear.get(period.fiscalYearId) ?? []),
      period.label,
    ]);
  }
  const entryByYear = new Map(
    entries.map((entry) => [
      entry.fiscalYearId,
      { id: entry.id, entryNumber: entry.entryNumber },
    ]),
  );

  // Ascending, so "is an earlier year still open" is answerable in one pass.
  const ascending = [...years].reverse();
  const blockedFrom = ascending.findIndex((year) => year.closedAt === null);

  return years.map((year) => {
    const openPeriods = openByYear.get(year.id) ?? [];
    const position = ascending.findIndex((entry) => entry.id === year.id);
    const earlierYearOpen = blockedFrom !== -1 && position > blockedFrom;

    return {
      ...year,
      openPeriods,
      closable:
        year.closedAt === null && openPeriods.length === 0 && !earlierYearOpen,
      closingEntry: entryByYear.get(year.id) ?? null,
    };
  });
}

/**
 * Transfers the year's income and expenses to retained earnings, and marks it
 * closed.
 *
 * Refused while any period inside it is open — a year is not settled while one
 * of its months still accepts entries — and refused while an earlier year is
 * open, for the reason periods close in order: the entry clears whatever is
 * sitting in the income accounts, and closing out of order would sweep an
 * earlier year's earnings into this year's.
 */
export async function closeFiscalYear(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  fiscalYearId: string;
  note?: string;
}): Promise<YearCloseView> {
  const year = await prisma.fiscalYear.findFirst({
    where: { id: params.fiscalYearId, companyId: params.companyId },
    select: {
      id: true,
      label: true,
      startDate: true,
      endDate: true,
      closedAt: true,
    },
  });
  if (!year) {
    throw new YearCloseError(
      "That financial year could not be found.",
      "NOT_FOUND",
    );
  }
  if (year.closedAt) {
    throw new YearCloseError(`${year.label} is already closed.`, "ALREADY");
  }

  const openPeriod = await prisma.fiscalPeriod.findFirst({
    where: {
      companyId: params.companyId,
      fiscalYearId: year.id,
      status: { not: FiscalPeriodStatus.CLOSED },
    },
    select: { label: true },
    orderBy: { startDate: "asc" },
  });
  if (openPeriod) {
    throw new YearCloseError(
      `${openPeriod.label} is still open. Close every month of ${year.label} before closing the year itself — a year is not settled while one of its months still takes entries.`,
      "PERIODS_OPEN",
    );
  }

  const earlierOpen = await prisma.fiscalYear.findFirst({
    where: {
      companyId: params.companyId,
      startDate: { lt: year.startDate },
      closedAt: null,
    },
    select: { label: true },
    orderBy: { startDate: "asc" },
  });
  if (earlierOpen) {
    throw new YearCloseError(
      `${earlierOpen.label} is still open, and it comes first. Closing out of order would sweep that year's earnings into this one.`,
      "ORDER",
    );
  }

  const entry = await prisma.$transaction(
    async (tx) => {
      const posted = await postClosingEntry(tx, { ...params, year });
      // Atomic with the entry: a year marked closed without its closing entry
      // would report last year's earnings as nil while retained earnings held
      // nothing, and the two halves of that are not separately useful.
      await tx.fiscalYear.update({
        where: { id: year.id },
        data: { closedAt: new Date() },
      });
      return posted;
    },
    { timeout: 30_000 },
  );

  await recordAuditLog({
    action: "fiscalYear.closed",
    module: "Accounting",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "FiscalYear",
    entityId: year.id,
    metadata: {
      year: year.label,
      entryNumber: entry?.entryNumber ?? null,
      note: params.note ?? null,
    },
  });

  return (await viewOf(params.companyId, year.id))!;
}

/**
 * The closing entry itself.
 *
 * Every income and expense account is brought to nil by posting the opposite of
 * whatever it is carrying, and the difference — the year's profit or loss —
 * lands in retained earnings. Posting the opposite of the *balance* rather than
 * "credit every expense" is what makes contra accounts come out right: sales
 * returns sit inside income carrying a debit, purchase returns inside cost of
 * sales carrying a credit, and each has to be cleared in the direction it
 * actually sits.
 */
async function postClosingEntry(
  tx: DbClient,
  params: {
    companyId: string;
    userId: string;
    year: { id: string; label: string; endDate: Date };
  },
): Promise<{ id: string; entryNumber: string } | null> {
  // As at the year end, not within a window: what has to be cleared is whatever
  // is sitting in the account on the last day. Earlier years are already closed
  // — the ordering rule above guarantees it — so nothing older is left in there.
  //
  // Retired accounts included, and that is not incidental. Closing brings every
  // income and expense account to nil, which is exactly when somebody tidies the
  // chart and puts away the ones they no longer use — retiring is allowed
  // because they all read zero. Reopen the year and close it again, and an
  // active-only read leaves whatever the retired account was carrying out of the
  // year's result, while the profit and loss account — which reads inactive
  // accounts too — goes on reporting it. The books balance either way, so
  // nothing complains; retained earnings simply carries a figure the statements
  // never showed.
  //
  // The guard on retiring an account asks whether it holds anything *now*, which
  // is the right question for putting one away. This asks what it held *at the
  // year end*. Different questions, and this is the one that has to see every
  // account.
  const balances = await accountBalances({
    companyId: params.companyId,
    to: params.year.endDate,
    includeInactive: true,
  });

  const lines: Array<{
    accountId: string;
    debit?: string;
    credit?: string;
    narration: string;
  }> = [];

  let debitTotal = money(0);
  let creditTotal = money(0);

  for (const account of balances) {
    if (account.type !== "INCOME" && account.type !== "EXPENSE") continue;

    const net = subtract(account.closingDebit, account.closingCredit);
    if (isZero(net)) continue;

    // A debit balance is cleared by a credit, and the other way round.
    if (compare(net, 0) > 0) {
      lines.push({
        accountId: account.id,
        credit: toStorageString(net),
        narration: `${account.name} closed to retained earnings`,
      });
      creditTotal = add(creditTotal, net);
    } else {
      const amount = subtract(money(0), net);
      lines.push({
        accountId: account.id,
        debit: toStorageString(amount),
        narration: `${account.name} closed to retained earnings`,
      });
      debitTotal = add(debitTotal, amount);
    }
  }

  // A year in which nothing was earned or spent needs no entry, and an empty
  // one would be noise in the journal.
  if (lines.length === 0) return null;

  const retained = balances.find(
    (account) => account.systemKey === SYSTEM_ACCOUNT.RETAINED_EARNINGS,
  );
  if (!retained) {
    throw new YearCloseError(
      "Retained earnings is missing from the chart of accounts, so there is nowhere for the year's result to go.",
      "NO_RETAINED_EARNINGS",
    );
  }

  // Debits above credits is a profit: clearing income means debiting it, so the
  // bigger the year's revenue the bigger the debit side of this entry.
  const result = subtract(debitTotal, creditTotal);
  lines.push(balanceLine(retained.id, result, params.year.label));

  const posted = await postJournalEntry(tx, {
    companyId: params.companyId,
    entryDate: params.year.endDate,
    voucherType: VoucherType.CLOSING_ENTRY,
    narration: `Closing entry for ${params.year.label}`,
    isSystem: true,
    createdById: params.userId,
    sourceType: "YEAR_CLOSE",
    sourceId: params.year.id,
    // The one entry allowed into a closed period, because it *is* the close.
    // Every month of the year has to be shut before the year can be, so by the
    // time this posts there is no open period left for it to land in.
    intoClosedPeriod: true,
    lines,
  });

  return { id: posted.id, entryNumber: posted.entryNumber };
}

/** The retained-earnings side: a profit is credited to it, a loss debited. */
function balanceLine(accountId: string, result: Decimal, label: string) {
  const profit = compare(result, 0) > 0;
  const amount = profit ? result : subtract(money(0), result);
  return {
    accountId,
    ...(profit
      ? { credit: toStorageString(amount) }
      : { debit: toStorageString(amount) }),
    narration: profit
      ? `Profit for ${label} retained`
      : `Loss for ${label} carried to retained earnings`,
  };
}

/**
 * Undoes a year's close.
 *
 * The closing entry is reversed rather than deleted, like every other
 * correction here, so the year's books show that it was closed and then
 * reopened rather than showing that it never happened. A reason is required:
 * the figures behind something already filed can move once the year is open
 * again, and whoever finds that later needs to know why.
 */
export async function reopenFiscalYear(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  fiscalYearId: string;
  reason: string;
}): Promise<YearCloseView> {
  const year = await prisma.fiscalYear.findFirst({
    where: { id: params.fiscalYearId, companyId: params.companyId },
    select: { id: true, label: true, endDate: true, closedAt: true },
  });
  if (!year) {
    throw new YearCloseError(
      "That financial year could not be found.",
      "NOT_FOUND",
    );
  }
  if (!year.closedAt) {
    throw new YearCloseError(`${year.label} is not closed.`, "NOT_CLOSED");
  }

  await prisma.$transaction(async (tx) => {
    const closing = await tx.journalEntry.findFirst({
      where: {
        companyId: params.companyId,
        fiscalYearId: year.id,
        voucherType: VoucherType.CLOSING_ENTRY,
        status: JournalStatus.POSTED,
        reversesId: null,
      },
      select: {
        id: true,
        lines: {
          select: {
            accountId: true,
            debit: true,
            credit: true,
            narration: true,
          },
          orderBy: { lineNumber: "asc" },
        },
      },
    });

    if (closing) {
      await postJournalEntry(tx, {
        companyId: params.companyId,
        entryDate: year.endDate,
        voucherType: VoucherType.CLOSING_ENTRY,
        narration: `Closing entry for ${year.label} reversed — ${params.reason}`,
        isSystem: true,
        createdById: params.userId,
        sourceType: "YEAR_REOPEN",
        sourceId: year.id,
        reversesId: closing.id,
        intoClosedPeriod: true,
        lines: closing.lines.map((line) => ({
          accountId: line.accountId,
          // Sides swapped: the reversal puts back exactly what was taken out.
          ...(isZero(line.debit)
            ? { debit: toStorageString(line.credit) }
            : { credit: toStorageString(line.debit) }),
          narration: line.narration ?? "Closing entry reversed",
        })),
      });
    }

    await tx.fiscalYear.update({
      where: { id: year.id },
      data: { closedAt: null },
    });
  });

  await recordAuditLog({
    action: "fiscalYear.reopened",
    module: "Accounting",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "FiscalYear",
    entityId: year.id,
    metadata: { year: year.label, reason: params.reason },
  });

  return (await viewOf(params.companyId, year.id))!;
}

async function viewOf(
  companyId: string,
  fiscalYearId: string,
): Promise<YearCloseView | null> {
  const years = await listYearsForClosing(companyId);
  return years.find((year) => year.id === fiscalYearId) ?? null;
}
