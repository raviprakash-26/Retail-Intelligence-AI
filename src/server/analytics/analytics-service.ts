import "server-only";
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
import { computeHealth, type HealthIndicator } from "@/lib/analytics/health";
import { RANGE_LABELS, type RangeKey } from "@/lib/analytics/range";
import { computeRatios, type Ratio } from "@/lib/analytics/ratios";
import {
  accountBalances,
  NATURAL_SIDE_FOR_TYPE,
  type AccountBalance,
} from "@/server/accounting/balances";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import {
  categoryMix,
  customerPerformance,
  granularityFor,
  productPerformance,
  revenueTrend,
  weekdayPattern,
  type CategoryMix,
  type CustomerPerformance,
  type Granularity,
  type ProductPerformance,
  type TrendPoint,
  type WeekdayPattern,
} from "@/server/analytics/sales-analytics";

/**
 * Analytics.
 *
 * Everything on this page is arithmetic on posted entries. No model produced
 * any of it, nothing here is a projection, and the figures reconcile with the
 * statements because they are read from the same balance engine rather than
 * computed alongside it — a dashboard that disagrees with the profit and loss
 * account is worse than no dashboard.
 *
 * The comparison against the previous period is the same length of time
 * immediately before this one, so a shop four months into its year is compared
 * with the four months before that. Comparing a part-year against a whole year
 * is the most common way a growth figure ends up meaning nothing.
 */

export type Movement = {
  current: string;
  previous: string;
  /** Change as a percentage, or null when the previous period had nothing. */
  changePercent: number | null;
  /** The absolute change, which is meaningful even when the percentage is not. */
  change: string;
};

export type Concentration = {
  /** Share of revenue taken by the single largest customer. */
  topSharePercent: number | null;
  topName: string | null;
  /** Share taken by the five largest. */
  topFiveSharePercent: number | null;
  /** Stated only when it is factually true, never as a warning to act on. */
  note: string | null;
};

export type AnalyticsReport = {
  range: RangeKey;
  rangeLabel: string;
  from: string;
  to: string;
  days: number;
  granularity: Granularity;
  /** The comparison window: the same length, immediately before. */
  previousFrom: string;
  previousTo: string;

  revenue: Movement;
  grossProfit: Movement;
  netProfit: Movement;
  /**
   * What it cost to run the shop, as the profit and loss account states it —
   * not gross profit less net profit, which would fold any other income into
   * the costs and say something false about both.
   */
  operatingExpenses: Movement;
  bills: { current: number; previous: number; changePercent: number | null };
  averageBill: Movement;

  trend: TrendPoint[];
  products: ProductPerformance[];
  customers: CustomerPerformance[];
  categories: CategoryMix[];
  weekdays: WeekdayPattern[];
  concentration: Concentration;

  ratios: Ratio[];
  health: HealthIndicator;

  /** True when the window contains no trading at all. */
  empty: boolean;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const DAY = 86_400_000;

/** Closing position, in the direction of the account type's own nature. */
function closingAmount(balance: AccountBalance): Decimal {
  return signedBalance(
    NATURAL_SIDE_FOR_TYPE[balance.type],
    balance.closingDebit,
    balance.closingCredit,
  );
}

function sumClosing(
  balances: readonly AccountBalance[],
  subTypes: readonly string[],
): Decimal {
  return add(
    ...balances
      .filter((balance) => subTypes.includes(balance.subType))
      .map(closingAmount),
  );
}

function movement(current: Decimal, previous: Decimal): Movement {
  const change = subtract(current, previous);
  return {
    current: toStorageString(current),
    previous: toStorageString(previous),
    change: toStorageString(change),
    // A percentage against nothing is not a large percentage, it is no
    // percentage — growth "from ₹0" is a division nobody should be shown.
    changePercent:
      compare(previous, 0) > 0
        ? Number(divide(change, previous).times(100).toDecimalPlaces(1))
        : null,
  };
}

/** The window being reported on, and the one it is compared against. */
export function resolveRange(params: {
  range: RangeKey;
  fiscalYearStart: Date;
  fiscalYearEnd: Date;
  today?: Date;
}): { from: Date; to: Date; previousFrom: Date; previousTo: Date } {
  const today = params.today ?? new Date();

  let from: Date;
  let to: Date;

  if (params.range === "fy") {
    from = params.fiscalYearStart;
    // A year that has not finished is reported up to today, not up to a future
    // date that would flatten every average with empty weeks.
    to =
      today.getTime() < params.fiscalYearEnd.getTime()
        ? new Date(
            Date.UTC(
              today.getUTCFullYear(),
              today.getUTCMonth(),
              today.getUTCDate(),
            ),
          )
        : params.fiscalYearEnd;
  } else {
    const span = params.range === "90d" ? 90 : 30;
    to = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    from = new Date(to.getTime() - (span - 1) * DAY);
  }

  const length = Math.max(
    1,
    Math.round((to.getTime() - from.getTime()) / DAY) + 1,
  );
  const previousTo = new Date(from.getTime() - DAY);
  const previousFrom = new Date(previousTo.getTime() - (length - 1) * DAY);

  return { from, to, previousFrom, previousTo };
}

/** Below this many customers, one large share is arithmetic, not concentration. */
const MINIMUM_NAMES_FOR_CONCENTRATION = 3;

/** The share at which one name is worth remarking on. */
const CONCENTRATION_SHARE_PERCENT = 40;

function concentrationOf(
  customers: readonly CustomerPerformance[],
): Concentration {
  if (customers.length === 0) {
    return {
      topSharePercent: null,
      topName: null,
      topFiveSharePercent: null,
      note: null,
    };
  }

  const top = customers[0]!;
  const topFive = customers
    .slice(0, 5)
    .reduce((sum, entry) => sum + entry.sharePercent, 0);

  // Stated as a fact about this period, not as a risk to act on. Whether one
  // large customer is a problem depends on the relationship, and this cannot
  // see the relationship.
  //
  // Worth remarking on only where there are enough names for concentration to
  // mean anything: with two customers a 50% share is arithmetic rather than an
  // observation, and saying it out loud is noise.
  const note =
    customers.length >= MINIMUM_NAMES_FOR_CONCENTRATION &&
    top.sharePercent >= CONCENTRATION_SHARE_PERCENT
      ? `${top.name} accounts for ${top.sharePercent.toFixed(1)}% of this period's sales.`
      : null;

  return {
    topSharePercent: top.sharePercent,
    topName: top.name,
    topFiveSharePercent: Number(topFive.toFixed(1)),
    note,
  };
}

export async function getAnalytics(params: {
  companyId: string;
  range: RangeKey;
  fiscalYearStart: Date;
  fiscalYearEnd: Date;
  today?: Date;
}): Promise<AnalyticsReport> {
  const { from, to, previousFrom, previousTo } = resolveRange(params);
  const days = Math.max(
    1,
    Math.round((to.getTime() - from.getTime()) / DAY) + 1,
  );
  const granularity = granularityFor(days);

  const [
    statements,
    previousStatements,
    periodBalances,
    closingBalances,
    trend,
    products,
    customers,
    categories,
    weekdays,
    billCounts,
    openingInventory,
  ] = await Promise.all([
    getFinancialStatements({
      companyId: params.companyId,
      from: isoDay(from),
      to: isoDay(to),
    }),
    getFinancialStatements({
      companyId: params.companyId,
      from: isoDay(previousFrom),
      to: isoDay(previousTo),
    }),
    accountBalances({ companyId: params.companyId, from, to }),
    accountBalances({ companyId: params.companyId, to }),
    revenueTrend({ companyId: params.companyId, from, to, granularity }),
    productPerformance({ companyId: params.companyId, from, to }),
    customerPerformance({ companyId: params.companyId, from, to }),
    categoryMix({ companyId: params.companyId, from, to }),
    weekdayPattern({ companyId: params.companyId, from, to }),
    Promise.all([
      prisma.sale.count({
        where: {
          companyId: params.companyId,
          status: "POSTED",
          invoiceDate: { gte: from, lte: to },
        },
      }),
      prisma.sale.count({
        where: {
          companyId: params.companyId,
          status: "POSTED",
          invoiceDate: { gte: previousFrom, lte: previousTo },
        },
      }),
    ]),
    // Stock at the instant the window opened, for the turnover denominator.
    accountBalances({
      companyId: params.companyId,
      to: new Date(from.getTime() - DAY),
    }),
  ]);

  const [currentBills, previousBills] = billCounts;

  const revenue = money(statements.trading.revenueTotal);
  const previousRevenue = money(previousStatements.trading.revenueTotal);
  const grossProfit = money(statements.trading.grossProfit);
  const netProfit = money(statements.profitAndLoss.netProfit);

  const averageBill =
    currentBills > 0 ? divide(revenue, currentBills) : money(0);
  const previousAverageBill =
    previousBills > 0 ? divide(previousRevenue, previousBills) : money(0);

  // Purchases as the payable-days denominator: goods bought in, which under
  // perpetual inventory is the movement on the Inventory account's debit side
  // rather than a Purchases expense account.
  const purchases = add(
    ...periodBalances
      .filter((balance) => balance.subType === "INVENTORY")
      .map((balance) => balance.periodDebit),
  );

  const ratios = computeRatios({
    days,
    revenue,
    costOfSales: money(statements.trading.costOfSalesTotal),
    grossProfit,
    operatingExpenses: money(statements.profitAndLoss.expensesTotal),
    netProfit,
    purchases,
    openingInventory: sumClosing(openingInventory, ["INVENTORY"]),
    closingInventory: sumClosing(closingBalances, ["INVENTORY"]),
    receivables: sumClosing(closingBalances, ["RECEIVABLE"]),
    payables: sumClosing(closingBalances, ["PAYABLE"]),
    currentAssets: sumClosing(closingBalances, [
      "CURRENT_ASSET",
      "INVENTORY",
      "RECEIVABLE",
      "CASH_AND_BANK",
    ]),
    currentLiabilities: sumClosing(closingBalances, [
      "CURRENT_LIABILITY",
      "PAYABLE",
      "TAX_LIABILITY",
    ]),
    // Taken from the balance sheet rather than by summing the equity accounts.
    // Nothing in this ledger closes the income accounts into capital, so the
    // equity accounts alone understate what is in the business by everything it
    // has earned; the balance sheet already adds that back, and reading its
    // figure is what keeps return on capital agreeing with the statements.
    equity: money(statements.balanceSheet.equityTotal),
  });

  return {
    range: params.range,
    rangeLabel: RANGE_LABELS[params.range],
    from: isoDay(from),
    to: isoDay(to),
    days,
    granularity,
    previousFrom: isoDay(previousFrom),
    previousTo: isoDay(previousTo),

    revenue: movement(revenue, previousRevenue),
    grossProfit: movement(
      grossProfit,
      money(previousStatements.trading.grossProfit),
    ),
    netProfit: movement(
      netProfit,
      money(previousStatements.profitAndLoss.netProfit),
    ),
    operatingExpenses: movement(
      money(statements.profitAndLoss.expensesTotal),
      money(previousStatements.profitAndLoss.expensesTotal),
    ),
    bills: {
      current: currentBills,
      previous: previousBills,
      changePercent:
        previousBills > 0
          ? Number(
              (((currentBills - previousBills) / previousBills) * 100).toFixed(
                1,
              ),
            )
          : null,
    },
    averageBill: movement(averageBill, previousAverageBill),

    trend,
    products,
    customers,
    categories,
    weekdays,
    concentration: concentrationOf(customers),

    ratios,
    health: computeHealth(ratios),

    empty: compare(revenue, 0) === 0 && currentBills === 0,
  };
}
