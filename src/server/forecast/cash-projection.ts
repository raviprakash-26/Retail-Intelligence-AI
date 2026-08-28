import "server-only";
import {
  DocumentStatus,
  JournalStatus,
  VoucherType,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { signedBalance } from "@/lib/accounting/double-entry";
import {
  add,
  compare,
  divide,
  money,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";
import {
  accountBalances,
  NATURAL_SIDE_FOR_TYPE,
  type AccountBalance,
} from "@/server/accounting/balances";
import {
  afterUnappliedCredit,
  settledByNotes,
  unappliedCreditByParty,
} from "@/server/settlements/outstanding";

/**
 * What the cash position looks like over the next few weeks.
 *
 * This is not a statistical forecast and it does not pretend to be. It is a
 * roll-forward of commitments that already exist: invoices already raised,
 * bills already received, and a running cost taken from what the shop has
 * actually been spending. Nothing is fitted, nothing is extrapolated, and
 * **money from sales not yet made is deliberately absent** — which makes this a
 * floor rather than a prediction, and the interface says so in those words.
 *
 * Two lines are drawn, both out of the shop's own records:
 *
 *   • **If everyone pays on time**, each invoice lands on its due date.
 *   • **If they pay as they have been**, every invoice is shifted by the number
 *     of days customers have actually been taking past the due date — measured
 *     from receipts already allocated, not assumed.
 *
 * The gap between those two lines is usually the most useful thing on the page,
 * because it is the cost of slow collection stated in weeks of cash.
 */

export type CashWeek = {
  start: string;
  end: string;
  openingCash: string;
  receiptsDue: string;
  paymentsDue: string;
  runningCosts: string;
  closingCash: string;
  /** The same week, with collections shifted by how late customers actually are. */
  closingCashIfLate: string;
  /** True where the on-time line dips below nil. */
  negative: boolean;
  /** True where only the late line dips below nil. */
  negativeIfLate: boolean;
};

export type Shortfall = { start: string; amount: string };

export type CashProjection = {
  from: string;
  to: string;
  openingCash: string;
  weeks: CashWeek[];
  /** The first week the on-time line goes below nil, if it does. */
  firstShortfall: Shortfall | null;
  /** The first week the late line goes below nil, if it does. */
  firstShortfallIfLate: Shortfall | null;
  weeklyRunningCost: string;
  runningCostBasis: string;
  /** Days past the due date customers have actually been taking. */
  latenessDays: number | null;
  latenessBasis: string;
  /** Invoices already past their due date, which land in the first week. */
  overdueReceivables: string;
  overduePayables: string;
  limitations: string[];
  unavailable: string | null;
};

const DAY = 86_400_000;
const WEEK = 7 * DAY;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Midnight UTC on the day a date falls in. */
function startOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function closingAmount(balance: AccountBalance): Decimal {
  return signedBalance(
    NATURAL_SIDE_FOR_TYPE[balance.type],
    balance.closingDebit,
    balance.closingCredit,
  );
}

type DueRow = { dueDate: Date; outstanding: Decimal };

/**
 * How many days past the due date customers have actually been paying.
 *
 * Measured from receipts already allocated to invoices, not from an assumption
 * and not from an average balance. A shop whose customers pay eleven days late
 * should see its cash line shifted by eleven days, and should see that number
 * because it is theirs.
 */
async function latenessInDays(params: {
  companyId: string;
  since: Date;
}): Promise<{ days: number | null; basis: string; sample: number }> {
  const rows = await prisma.$queryRaw<
    Array<{ late: Prisma.Decimal | null; sample: bigint }>
  >`
    SELECT AVG(GREATEST(0, r."receiptDate" - COALESCE(s."dueDate", s."invoiceDate")))::numeric AS late,
           COUNT(*)::bigint AS sample
    FROM receipt_allocations ra
    JOIN receipts r ON r.id = ra."receiptId"
    JOIN sales s    ON s.id = ra."saleId"
    WHERE ra."companyId" = ${params.companyId}::uuid
      AND r.status = 'POSTED'
      AND r."receiptDate" >= ${params.since}
  `;

  const row = rows[0];
  const sample = Number(row?.sample ?? 0);
  if (!row || sample === 0 || row.late === null) {
    return {
      days: null,
      sample: 0,
      basis:
        "No invoice has been settled by a receipt yet, so there is nothing to measure how late customers run.",
    };
  }

  const days = Math.round(Number(row.late));
  return {
    days,
    sample,
    basis: `Measured from ${sample} ${sample === 1 ? "settlement" : "settlements"} in the last six months: customers have been paying ${days} ${days === 1 ? "day" : "days"} past the due date on average.`,
  };
}

/**
 * Open invoices or bills, by the date they fall due.
 *
 * A credit note settles a document as surely as a payment does, and this was
 * counting only the payments. So an invoice half credited back was still
 * expected in full, and money the customer no longer owes was still arriving in
 * a particular week. That is the wrong direction for this figure in particular:
 * the projection is offered as a floor rather than a prediction, and a floor
 * that counts money nobody is going to send is the one a shop walks off.
 *
 * Money already received against no invoice in particular was the same fault
 * again, and worse here than anywhere it has been found. Elsewhere an
 * unapplied receipt merely overstates what is owed; here the money is already
 * sitting in the cash and bank balance this projection opens at, so counting
 * the invoice at full value puts the same rupee in twice. It reads as more
 * cash than the shop has, in the figure somebody uses to decide whether next
 * month's wages will clear, on a page that calls itself a floor.
 *
 * `settledByNotes`, `unappliedCreditByParty` and `afterUnappliedCredit` are
 * the same functions the ageing report and the auditor use, for the same
 * reason they share them — several places deciding separately what a document
 * still owes is several chances to decide differently, and this module has now
 * been on the wrong end of that twice.
 */
async function dueSchedule(params: {
  companyId: string;
  kind: "receivable" | "payable";
}): Promise<DueRow[]> {
  const side = params.kind === "receivable" ? "RECEIVABLE" : "PAYABLE";

  const rows =
    params.kind === "receivable"
      ? (
          await prisma.sale.findMany({
            where: {
              companyId: params.companyId,
              status: DocumentStatus.POSTED,
            },
            select: {
              id: true,
              customerId: true,
              invoiceDate: true,
              dueDate: true,
              totalAmount: true,
              paidAmount: true,
            },
          })
        ).map((sale) => ({
          id: sale.id,
          partyId: sale.customerId ?? "",
          dueDate: sale.dueDate ?? sale.invoiceDate,
          total: sale.totalAmount,
          paid: sale.paidAmount,
        }))
      : (
          await prisma.purchase.findMany({
            where: {
              companyId: params.companyId,
              status: DocumentStatus.POSTED,
            },
            select: {
              id: true,
              supplierId: true,
              billDate: true,
              dueDate: true,
              totalAmount: true,
              paidAmount: true,
            },
          })
        ).map((purchase) => ({
          id: purchase.id,
          partyId: purchase.supplierId ?? "",
          dueDate: purchase.dueDate ?? purchase.billDate,
          total: purchase.totalAmount,
          paid: purchase.paidAmount,
        }));

  const settled = await settledByNotes(prisma, {
    companyId: params.companyId,
    documentIds: rows.map((row) => row.id),
    side,
  });

  const open = rows
    .map((row) => ({
      partyId: row.partyId,
      dueDate: row.dueDate,
      outstanding: subtract(
        row.total,
        add(row.paid, settled.get(row.id) ?? money(0)),
      ),
    }))
    .filter((row) => compare(row.outstanding, 0) > 0);

  // Money already received against no invoice in particular — or already paid
  // against no bill.
  //
  // This is worse here than anywhere else it has been missed. The money is not
  // merely absent from the future: a receipt sitting unallocated is already in
  // the cash and bank balance this projection opens at, so counting the
  // invoice at full value puts the same rupee in twice. On the receivable side
  // that overstates the cash a shop will have, in a figure the page calls a
  // floor and somebody reads to decide whether wages will clear.
  const documented = new Map<string, Decimal>();
  for (const row of open) {
    if (!row.partyId) continue;
    documented.set(
      row.partyId,
      add(documented.get(row.partyId) ?? money(0), row.outstanding),
    );
  }

  const held = await unappliedCreditByParty({
    companyId: params.companyId,
    side,
    documented,
  });

  return afterUnappliedCredit(open, held).filter(
    (row) => compare(row.outstanding, 0) > 0,
  );
}

/**
 * Sums what falls due inside each week.
 *
 * Anything already past its due date lands in the first week rather than being
 * dropped: it is owed now, and a projection that quietly forgets overdue money
 * is a projection that flatters.
 */
function bucketByWeek(
  rows: readonly DueRow[],
  weekStarts: readonly Date[],
  shiftDays = 0,
): Decimal[] {
  const buckets = weekStarts.map(() => money(0));
  const firstStart = weekStarts[0];
  if (!firstStart) return buckets;

  for (const row of rows) {
    const due = new Date(row.dueDate.getTime() + shiftDays * DAY);
    let index = Math.floor((due.getTime() - firstStart.getTime()) / WEEK);
    if (index < 0) index = 0;
    if (index >= buckets.length) continue;
    buckets[index] = add(buckets[index]!, row.outstanding);
  }

  return buckets;
}

/** What falls due before the window opens at all. */
function overdueBefore(rows: readonly DueRow[], from: Date): Decimal {
  return add(
    ...rows
      .filter((row) => row.dueDate.getTime() < from.getTime())
      .map((row) => row.outstanding),
  );
}

/** Weeks of history used to work out what the shop spends running itself. */
const RUNNING_COST_WEEKS = 13;

/** Weeks of settlement history used to measure how late customers run. */
const LATENESS_LOOKBACK_DAYS = 182;

export async function getCashProjection(params: {
  companyId: string;
  /** How many weeks forward. */
  weeks: number;
  today?: Date;
}): Promise<CashProjection> {
  const today = startOfDay(params.today ?? new Date());
  const horizonEnd = new Date(today.getTime() + params.weeks * WEEK - DAY);
  const costWindowFrom = new Date(today.getTime() - RUNNING_COST_WEEKS * WEEK);

  const [firstEntry, position, costWindow, receivables, payables, lateness] =
    await Promise.all([
      // The earliest thing these books actually record, opening and closing
      // entries aside: those are positions carried in and settled up, not
      // trading, and a shop that registered in August with its opening balances
      // dated to the start of the year has not been running since April.
      prisma.journalEntry.findFirst({
        where: {
          companyId: params.companyId,
          status: JournalStatus.POSTED,
          voucherType: {
            notIn: [VoucherType.OPENING_BALANCE, VoucherType.CLOSING_ENTRY],
          },
        },
        orderBy: { entryDate: "asc" },
        select: { entryDate: true },
      }),
      accountBalances({ companyId: params.companyId, to: today }),
      accountBalances({
        companyId: params.companyId,
        from: costWindowFrom,
        to: today,
      }),
      dueSchedule({ companyId: params.companyId, kind: "receivable" }),
      dueSchedule({ companyId: params.companyId, kind: "payable" }),
      latenessInDays({
        companyId: params.companyId,
        since: new Date(today.getTime() - LATENESS_LOOKBACK_DAYS * DAY),
      }),
    ]);

  const openingCash = add(
    ...position
      .filter((balance) => balance.subType === "CASH_AND_BANK")
      .map(closingAmount),
  );

  // Running costs: what the profit and loss account actually absorbed over the
  // last quarter, excluding depreciation — which is a real cost and not a
  // movement of cash, and putting it in a cash projection would be wrong.
  const cashExpenses = add(
    ...costWindow
      .filter(
        (balance) =>
          balance.section === "PROFIT_AND_LOSS" &&
          balance.type === "EXPENSE" &&
          balance.subType !== "DEPRECIATION",
      )
      .map((balance) =>
        signedBalance(
          NATURAL_SIDE_FOR_TYPE[balance.type],
          balance.periodDebit,
          balance.periodCredit,
        ),
      ),
  );
  // Divided by however much of the window these books actually cover.
  //
  // Thirteen weeks of spending over thirteen weeks is an average. Two weeks of
  // spending over thirteen is not, and dividing it by thirteen told a shop a
  // fortnight old that its running cost was a seventh of what it was paying —
  // which moved the week it runs out of money months into the future. The
  // error runs in the dangerous direction and lands on the businesses least
  // able to absorb it: a shop that has just opened is the one that most needs
  // to know when the cash runs out.
  //
  // The revenue projection beside this one already refuses to guess from three
  // weeks of history, and the advisor makes the same guard against its stale
  // stock window. This is that, with money.
  const booksStart =
    firstEntry && firstEntry.entryDate.getTime() > costWindowFrom.getTime()
      ? firstEntry.entryDate
      : costWindowFrom;
  const weeksOfBooks = Math.max(
    // At least one: a shop that opened this morning has a week's worth of costs
    // at most, and dividing by nought is not an average of anything.
    1,
    Math.round((today.getTime() - booksStart.getTime()) / WEEK),
  );
  const weeklyRunningCost = divide(cashExpenses, weeksOfBooks);

  const weekStarts = Array.from(
    { length: params.weeks },
    (_, index) => new Date(today.getTime() + index * WEEK),
  );

  const receiptsOnTime = bucketByWeek(receivables, weekStarts);
  const receiptsIfLate = bucketByWeek(
    receivables,
    weekStarts,
    lateness.days ?? 0,
  );
  const paymentsDue = bucketByWeek(payables, weekStarts);

  let runningOnTime = openingCash;
  let runningIfLate = openingCash;
  let firstShortfall: Shortfall | null = null;
  let firstShortfallIfLate: Shortfall | null = null;

  const weeks: CashWeek[] = weekStarts.map((start, index) => {
    const opening = runningOnTime;
    const receipts = receiptsOnTime[index] ?? money(0);
    const payments = paymentsDue[index] ?? money(0);

    const closing = subtract(
      add(opening, receipts),
      add(payments, weeklyRunningCost),
    );
    const closingIfLate = subtract(
      add(runningIfLate, receiptsIfLate[index] ?? money(0)),
      add(payments, weeklyRunningCost),
    );

    runningOnTime = closing;
    runningIfLate = closingIfLate;

    const negative = compare(closing, 0) < 0;
    const negativeIfLate = compare(closingIfLate, 0) < 0;

    if (negative && !firstShortfall) {
      firstShortfall = {
        start: isoDay(start),
        amount: toStorageString(closing),
      };
    }
    if (negativeIfLate && !firstShortfallIfLate) {
      firstShortfallIfLate = {
        start: isoDay(start),
        amount: toStorageString(closingIfLate),
      };
    }

    return {
      start: isoDay(start),
      end: isoDay(new Date(start.getTime() + WEEK - DAY)),
      openingCash: toStorageString(opening),
      receiptsDue: toStorageString(receipts),
      paymentsDue: toStorageString(payments),
      runningCosts: toStorageString(weeklyRunningCost),
      closingCash: toStorageString(closing),
      closingCashIfLate: toStorageString(closingIfLate),
      negative,
      negativeIfLate: negativeIfLate && !negative,
    };
  });

  const limitations = [
    "This counts only money already invoiced and already owed. Sales you make over the next few weeks are not in it, so treat the line as a floor rather than a prediction.",
    "Running costs are an average of the last quarter spread evenly. A rent day or a salary run falls on one date in reality, not a seventh of it each day.",
    "Depreciation is excluded, because it is a real cost that never moves any cash.",
  ];
  if (lateness.days === null) {
    limitations.push(
      "No invoice has been settled by a receipt yet, so the two lines are identical — there is nothing yet to say how late customers run.",
    );
  }

  return {
    from: isoDay(today),
    to: isoDay(horizonEnd),
    openingCash: toStorageString(openingCash),
    weeks,
    firstShortfall,
    firstShortfallIfLate,
    weeklyRunningCost: toStorageString(weeklyRunningCost),
    runningCostBasis: `An average of the last ${weeksOfBooks} weeks: ${toStorageString(cashExpenses)} of running costs, excluding depreciation.`,
    latenessDays: lateness.days,
    latenessBasis: lateness.basis,
    overdueReceivables: toStorageString(overdueBefore(receivables, today)),
    overduePayables: toStorageString(overdueBefore(payables, today)),
    limitations,
    unavailable: weeks.length === 0 ? "No weeks were asked for." : null,
  };
}
