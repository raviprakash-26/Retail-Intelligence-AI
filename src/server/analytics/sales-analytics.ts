import "server-only";
import { Prisma, VoucherType } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  add,
  compare,
  divide,
  money,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";

/**
 * What the shop actually sold, cut the ways a shopkeeper asks about it.
 *
 * Two different readings live here on purpose, and the interface says which is
 * which.
 *
 * **The trend reads the ledger.** Revenue per week is the movement on the
 * trading-account income accounts, exactly as the profit and loss account
 * defines it, so the buckets add up to the revenue on the statements rather
 * than to something close to it. A manual entry to Sales belongs in the trend
 * for the same reason it belongs in the P&L.
 *
 * **The breakdowns read the invoice lines.** Which product earned what cannot
 * come from the ledger, because the ledger does not know about products. That
 * makes the two views answer slightly different questions where a manual entry
 * or a separately-posted discount exists, which is stated on the page rather
 * than reconciled away.
 */

export type Granularity = "day" | "week" | "month";

/** Buckets wide enough to read, narrow enough to show a shape. */
export function granularityFor(days: number): Granularity {
  if (days <= 45) return "day";
  if (days <= 200) return "week";
  return "month";
}

const TRUNC_UNIT: Record<Granularity, Prisma.Sql> = {
  day: Prisma.sql`'day'`,
  week: Prisma.sql`'week'`,
  month: Prisma.sql`'month'`,
};

export type TrendPoint = {
  /** ISO date of the start of the bucket. */
  start: string;
  revenue: string;
  costOfSales: string;
  grossProfit: string;
  bills: number;
};

type TrendRow = {
  bucket: Date;
  revenue: Prisma.Decimal | null;
  cost_of_sales: Prisma.Decimal | null;
};

type BillRow = { bucket: Date; bills: number };

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Revenue and gross profit over time.
 *
 * Grouped in the database. A year of a busy shop is hundreds of thousands of
 * journal lines, and pulling them across to bucket them in JavaScript is the
 * kind of thing that works in a demo and falls over in March.
 */
export async function revenueTrend(params: {
  companyId: string;
  from: Date;
  to: Date;
  granularity: Granularity;
}): Promise<TrendPoint[]> {
  const unit = TRUNC_UNIT[params.granularity];

  const [rows, bills] = await Promise.all([
    prisma.$queryRaw<TrendRow[]>`
      SELECT date_trunc(${unit}, l."entryDate")::date AS bucket,
             SUM(CASE WHEN a."type" = 'INCOME'  THEN l.credit - l.debit ELSE 0 END) AS revenue,
             SUM(CASE WHEN a."type" = 'EXPENSE' THEN l.debit - l.credit ELSE 0 END) AS cost_of_sales
      FROM journal_lines l
      JOIN accounts a ON a.id = l."accountId"
      JOIN journal_entries e ON e.id = l."journalEntryId"
      WHERE l."companyId" = ${params.companyId}::uuid
        AND l.status = 'POSTED'
        AND l."entryDate" >= ${params.from}
        AND l."entryDate" <= ${params.to}
        AND a."section" = 'TRADING'
        -- The year-end transfer is not trading. It moves every income and
        -- expense account by the whole of its balance on one day, so a window
        -- containing it carries the year straight back out again and the
        -- buckets sum to nil against a profit and loss account showing the real
        -- figure. BalanceWindow.excludeClosingEntries is the same rule for the
        -- readers that go through accountBalances; this one reads the lines
        -- itself and needs it said here.
        AND e."voucherType" <> ${VoucherType.CLOSING_ENTRY}::"VoucherType"
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.$queryRaw<BillRow[]>`
      SELECT date_trunc(${unit}, s."invoiceDate")::date AS bucket,
             COUNT(*)::int AS bills
      FROM sales s
      WHERE s."companyId" = ${params.companyId}::uuid
        AND s.status = 'POSTED'
        AND s."invoiceDate" >= ${params.from}
        AND s."invoiceDate" <= ${params.to}
      GROUP BY 1
      ORDER BY 1
    `,
  ]);

  const billsByBucket = new Map(
    bills.map((row) => [isoDay(row.bucket), row.bills]),
  );

  return rows.map((row) => {
    const revenue = money(row.revenue ?? 0);
    const costOfSales = money(row.cost_of_sales ?? 0);
    const start = isoDay(row.bucket);

    return {
      start,
      revenue: toStorageString(revenue),
      costOfSales: toStorageString(costOfSales),
      grossProfit: toStorageString(subtract(revenue, costOfSales)),
      bills: billsByBucket.get(start) ?? 0,
    };
  });
}

export type ProductPerformance = {
  productId: string;
  sku: string;
  name: string;
  quantity: string;
  revenue: string;
  cost: string;
  grossProfit: string;
  /** Null where the product was given away or returned to nil revenue. */
  marginPercent: number | null;
  /** Share of the period's invoice-line revenue. */
  sharePercent: number;
};

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  quantity: Prisma.Decimal | null;
  revenue: Prisma.Decimal | null;
  cost: Prisma.Decimal | null;
};

/**
 * What each product earned, and what it cost to earn it.
 *
 * The cost is the unit cost captured on the line when the sale posted, not
 * today's purchase price — which is the whole point of storing it there. A
 * margin recomputed from the current price would move every time a supplier
 * changed theirs, and would say something different about last month every
 * month.
 */
export async function productPerformance(params: {
  companyId: string;
  from: Date;
  to: Date;
}): Promise<ProductPerformance[]> {
  const rows = await prisma.$queryRaw<ProductRow[]>`
    SELECT p.id, p.sku, p.name,
           SUM(m.quantity)                  AS quantity,
           SUM(m.taxable)                   AS revenue,
           SUM(m.quantity * m."unitCost")   AS cost
    FROM (
      SELECT si."productId", si.quantity, si."taxableAmount" AS taxable,
             si."unitCost"
        FROM sale_items si
        JOIN sales s ON s.id = si."saleId"
       WHERE si."companyId" = ${params.companyId}::uuid
         AND s.status = 'POSTED'
         AND s."invoiceDate" >= ${params.from}
         AND s."invoiceDate" <= ${params.to}
      UNION ALL
      -- Negated rather than filtered out: what came back is not a sale that
      -- never happened, it is a sale partly undone, and the difference is
      -- visible whenever only some of a line is returned.
      SELECT ri."productId", -ri.quantity, -ri."taxableAmount",
             ri."unitCost"
        FROM sales_return_items ri
        JOIN sales_returns r ON r.id = ri."salesReturnId"
       WHERE ri."companyId" = ${params.companyId}::uuid
         AND r.status = 'POSTED'
         AND r."returnDate" >= ${params.from}
         AND r."returnDate" <= ${params.to}
    ) m
    JOIN products p ON p.id = m."productId"
    GROUP BY p.id, p.sku, p.name
  `;

  const total = add(...rows.map((row) => money(row.revenue ?? 0)));

  return rows
    .map((row) => {
      const revenue = money(row.revenue ?? 0);
      const cost = money(row.cost ?? 0);
      const grossProfit = subtract(revenue, cost);

      return {
        productId: row.id,
        sku: row.sku,
        name: row.name,
        quantity: toStorageString(money(row.quantity ?? 0)),
        revenue: toStorageString(revenue),
        cost: toStorageString(cost),
        grossProfit: toStorageString(grossProfit),
        marginPercent: percentOf(grossProfit, revenue),
        sharePercent: percentOf(revenue, total) ?? 0,
      };
    })
    .sort((a, b) => Number(b.revenue) - Number(a.revenue));
}

export type CustomerPerformance = {
  customerId: string | null;
  name: string;
  revenue: string;
  bills: number;
  sharePercent: number;
};

type CustomerRow = {
  customerId: string | null;
  name: string | null;
  revenue: Prisma.Decimal | null;
  bills: number;
};

export async function customerPerformance(params: {
  companyId: string;
  from: Date;
  to: Date;
}): Promise<CustomerPerformance[]> {
  const rows = await prisma.$queryRaw<CustomerRow[]>`
    SELECT m."customerId", c.name,
           SUM(m.taxable)      AS revenue,
           SUM(m.bill)::int    AS bills
    FROM (
      SELECT s."customerId", s."taxableAmount" AS taxable, 1 AS bill
        FROM sales s
       WHERE s."companyId" = ${params.companyId}::uuid
         AND s.status = 'POSTED'
         AND s."invoiceDate" >= ${params.from}
         AND s."invoiceDate" <= ${params.to}
      UNION ALL
      -- Revenue comes off; the bill does not. The customer was invoiced, and a
      -- count of bills that fell when goods came back would say a shop had
      -- served somebody fewer times than it did.
      SELECT r."customerId", -r."taxableAmount", 0
        FROM sales_returns r
       WHERE r."companyId" = ${params.companyId}::uuid
         AND r.status = 'POSTED'
         AND r."returnDate" >= ${params.from}
         AND r."returnDate" <= ${params.to}
    ) m
    LEFT JOIN customers c ON c.id = m."customerId"
    GROUP BY 1, 2
  `;

  const total = add(...rows.map((row) => money(row.revenue ?? 0)));

  return rows
    .map((row) => ({
      customerId: row.customerId,
      // A sale with no customer is a counter sale, not an unnamed customer.
      name: row.name ?? "Counter sales",
      revenue: toStorageString(money(row.revenue ?? 0)),
      bills: row.bills,
      sharePercent: percentOf(money(row.revenue ?? 0), total) ?? 0,
    }))
    .sort((a, b) => Number(b.revenue) - Number(a.revenue));
}

export type CategoryMix = {
  categoryId: string | null;
  name: string;
  revenue: string;
  sharePercent: number;
};

type CategoryRow = {
  categoryId: string | null;
  name: string | null;
  revenue: Prisma.Decimal | null;
};

export async function categoryMix(params: {
  companyId: string;
  from: Date;
  to: Date;
}): Promise<CategoryMix[]> {
  const rows = await prisma.$queryRaw<CategoryRow[]>`
    SELECT p."categoryId", cat.name,
           SUM(m.taxable) AS revenue
    FROM (
      SELECT si."productId", si."taxableAmount" AS taxable
        FROM sale_items si
        JOIN sales s ON s.id = si."saleId"
       WHERE si."companyId" = ${params.companyId}::uuid
         AND s.status = 'POSTED'
         AND s."invoiceDate" >= ${params.from}
         AND s."invoiceDate" <= ${params.to}
      UNION ALL
      SELECT ri."productId", -ri."taxableAmount"
        FROM sales_return_items ri
        JOIN sales_returns r ON r.id = ri."salesReturnId"
       WHERE ri."companyId" = ${params.companyId}::uuid
         AND r.status = 'POSTED'
         AND r."returnDate" >= ${params.from}
         AND r."returnDate" <= ${params.to}
    ) m
    JOIN products p          ON p.id = m."productId"
    LEFT JOIN categories cat ON cat.id = p."categoryId"
    GROUP BY 1, 2
  `;

  const total = add(...rows.map((row) => money(row.revenue ?? 0)));

  return rows
    .map((row) => ({
      categoryId: row.categoryId,
      name: row.name ?? "Uncategorised",
      revenue: toStorageString(money(row.revenue ?? 0)),
      sharePercent: percentOf(money(row.revenue ?? 0), total) ?? 0,
    }))
    .sort((a, b) => Number(b.revenue) - Number(a.revenue));
}

export type WeekdayPattern = {
  /** 0 is Sunday, as PostgreSQL numbers it. */
  weekday: number;
  label: string;
  revenue: string;
  bills: number;
};

type WeekdayRow = {
  weekday: number;
  revenue: Prisma.Decimal | null;
  bills: number;
};

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * Which days of the week the shop actually earns on.
 *
 * Every weekday is returned, including the ones with nothing on them — a
 * missing Tuesday would read as a formatting quirk, where an empty Tuesday
 * reads as a fact about the business.
 *
 * **A return is carried back to the day of the sale it undoes**, and this is
 * the one breakdown where that matters. The other three net a return against
 * the same dimension the sale carried — the product, the customer, the
 * category — and those are identical on both documents, so taking the return
 * on its own date lands it in the right bucket. Here the dimension *is* the
 * date. A Tuesday sale returned on Thursday would take value off Thursday and
 * leave Tuesday standing at full, which reports the wrong strongest day twice
 * over.
 *
 * So both halves are windowed on the sale's own date, and a return of a sale
 * from before the window does not appear at all: the question this answers is
 * what the trade done on each weekday *in this period* came to, once what came
 * back is taken off it. A return whose sale has since been deleted carries no
 * date to attribute it to and is dropped by the join.
 *
 * This ran gross of returns, while the three breakdowns beside it ran net. The
 * panel is titled "Which days earn" and names a strongest day as a fact, so a
 * shop whose biggest Tuesday came back was being told the wrong one.
 *
 * The bill count does not fall, for the reason `customerPerformance` gives
 * about its own: the customer was invoiced, and a count that dropped when
 * goods came back would say a shop had served somebody fewer times than it
 * did.
 */
export async function weekdayPattern(params: {
  companyId: string;
  from: Date;
  to: Date;
}): Promise<WeekdayPattern[]> {
  const rows = await prisma.$queryRaw<WeekdayRow[]>`
    SELECT EXTRACT(DOW FROM d.sold_on)::int AS weekday,
           SUM(d.taxable)                  AS revenue,
           SUM(d.bill)::int                AS bills
    FROM (
      SELECT s."invoiceDate" AS sold_on, s."taxableAmount" AS taxable, 1 AS bill
        FROM sales s
       WHERE s."companyId" = ${params.companyId}::uuid
         AND s.status = 'POSTED'
         AND s."invoiceDate" >= ${params.from}
         AND s."invoiceDate" <= ${params.to}
      UNION ALL
      SELECT s."invoiceDate", -r."taxableAmount", 0
        FROM sales_returns r
        JOIN sales s ON s.id = r."saleId"
       WHERE r."companyId" = ${params.companyId}::uuid
         AND r.status = 'POSTED'
         AND s.status = 'POSTED'
         AND s."invoiceDate" >= ${params.from}
         AND s."invoiceDate" <= ${params.to}
    ) d
    GROUP BY 1
  `;

  const byDay = new Map(rows.map((row) => [row.weekday, row]));

  return WEEKDAYS.map((label, weekday) => {
    const row = byDay.get(weekday);
    return {
      weekday,
      label,
      revenue: toStorageString(money(row?.revenue ?? 0)),
      bills: row?.bills ?? 0,
    };
  });
}

/** A percentage of a base, or null when the base cannot carry one. */
function percentOf(part: Decimal, whole: Decimal): number | null {
  if (compare(whole, 0) <= 0) return null;
  return Number(divide(part, whole).times(100).toDecimalPlaces(1));
}
