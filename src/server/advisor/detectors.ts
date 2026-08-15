import { formatCurrency } from "@/lib/format";
import {
  abs,
  add,
  compare,
  divide,
  money,
  multiply,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";
import {
  estimated,
  recorded,
  unquantified,
  urgencyFor,
  type Suggestion,
} from "@/lib/advisor/impact";
import type { AnalyticsReport } from "@/server/analytics/analytics-service";
import type { CashProjection } from "@/server/forecast/cash-projection";
import type { LedgerAgeing } from "@/server/settlements/outstanding";
import type { StockRow } from "@/server/inventory/inventory-report";
import type { SuggestionKey } from "@/lib/advisor/catalogue";

/**
 * What the books have to show before the advisor says anything.
 *
 * Each detector is a pure function of figures other parts of the platform have
 * already computed — the ageing, the cash projection, the analytics report,
 * the stock positions. Nothing here queries anything, nothing here recomputes a
 * financial figure, and no model is involved at any point. Given the same
 * inputs these produce the same suggestions, every time, which is what makes
 * them arguable.
 *
 * Every threshold is a named constant. A suggestion that fires at a number
 * nobody can point to is one nobody can disagree with.
 */

/** Below this, an amount is noise rather than a suggestion. */
export const MINIMUM_AMOUNT = 1_000;

/** Stock that has not moved in this long is sitting still. */
export const STALE_STOCK_DAYS = 90;

/** A product must be at least this share of revenue before its margin matters. */
export const MATERIAL_PRODUCT_SHARE_PERCENT = 5;

/** How far below the shop's own average margin a line has to sit. */
export const MARGIN_GAP_POINTS = 10;

/** How far gross margin has to fall against the previous period. */
export const MARGIN_DROP_POINTS = 3;

/** How much faster costs must grow than sales before it is worth saying. */
export const EXPENSE_GROWTH_GAP_POINTS = 10;

/** A cash cycle longer than this is worth a look in most retail trades. */
export const LONG_CASH_CYCLE_DAYS = 90;

/** The improvement a shortening cycle is costed at: one week of it. */
export const CYCLE_IMPROVEMENT_DAYS = 7;

export type AdvisorInputs = {
  analytics: AnalyticsReport;
  receivables: LedgerAgeing;
  payables: LedgerAgeing;
  cash: CashProjection;
  stock: readonly StockRow[];
  /**
   * When these books start. Opening stock is dated the first day of the
   * financial year whatever day it was entered, so without this a shop that
   * registered this morning is told its stock has been sitting still for four
   * months — which is the fastest way to teach somebody to ignore the page.
   */
  booksStartedAt: Date;
  today: Date;
};

type Detector = {
  key: Suggestion["key"];
  detect: (
    inputs: AdvisorInputs,
  ) => Omit<Suggestion, "urgency" | "escalated" | "key"> | null;
};

const DAY = 86_400_000;

const daysBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY));

/** Figures inside a sentence are formatted; figures in evidence stay exact. */
const rupees = (value: Decimal): string =>
  formatCurrency(value, { compactZeroDecimals: true });

const percent = (part: Decimal, whole: Decimal): number | null =>
  compare(whole, 0) > 0
    ? Number(multiply(divide(part, whole), 100).toDecimalPlaces(1))
    : null;

const DETECTORS: readonly Detector[] = [
  {
    key: "OVERDUE_RECEIVABLES",
    detect: ({ receivables }) => {
      const overdue = money(receivables.summary.overdue);
      if (compare(overdue, MINIMUM_AMOUNT) < 0) return null;

      const parties = receivables.parties.filter(
        (party) => compare(party.overdue, 0) > 0,
      );
      const oldest = receivables.summary.oldestOverdueDays;

      return {
        observation:
          `${rupees(overdue)} is past its due date across ` +
          `${parties.length} ${parties.length === 1 ? "customer" : "customers"}` +
          (oldest === null ? "." : `, the oldest by ${oldest} days.`),
        evidence: {
          overdue: toStorageString(overdue),
          customers: parties.length,
          oldestOverdueDays: oldest ?? 0,
          totalOutstanding: receivables.summary.total,
        },
        // Not an estimate of anything. This money has been earned, invoiced,
        // and is sitting somewhere other than the bank.
        impact: recorded(overdue, "already earned and invoiced"),
      };
    },
  },

  {
    key: "OVERDUE_PAYABLES",
    detect: ({ payables }) => {
      const overdue = money(payables.summary.overdue);
      if (compare(overdue, MINIMUM_AMOUNT) < 0) return null;

      const parties = payables.parties.filter(
        (party) => compare(party.overdue, 0) > 0,
      );
      const oldest = payables.summary.oldestOverdueDays;

      return {
        observation:
          `${rupees(overdue)} is past its due date across ` +
          `${parties.length} ${parties.length === 1 ? "supplier" : "suppliers"}` +
          (oldest === null ? "." : `, the oldest by ${oldest} days.`),
        evidence: {
          overdue: toStorageString(overdue),
          suppliers: parties.length,
          oldestOverdueDays: oldest ?? 0,
          totalOutstanding: payables.summary.total,
        },
        // Recorded, not estimated: these bills were received and posted. What
        // is deliberately not said is anything about whether the shop can pay
        // them — that depends on money the books cannot see.
        impact: recorded(overdue, "already received and unpaid"),
      };
    },
  },

  {
    key: "CASH_SHORTFALL_AHEAD",
    detect: ({ cash }) => {
      if (cash.unavailable) return null;
      const shortfall = cash.firstShortfall ?? cash.firstShortfallIfLate;
      if (!shortfall) return null;

      const onTime = cash.firstShortfall !== null;

      return {
        observation: onTime
          ? `On what is already committed, the week of ${shortfall.start} ends below nil.`
          : `The week of ${shortfall.start} ends below nil if customers pay as late as they have been paying — ${cash.latenessDays ?? 0} days past due on average. On time, it does not.`,
        evidence: {
          week: shortfall.start,
          shortfall: shortfall.amount,
          line: onTime ? "on time" : "if customers pay as late as they have",
          latenessDays: cash.latenessDays ?? 0,
          overdueReceivables: cash.overdueReceivables,
        },
        impact: recorded(abs(shortfall.amount), "the size of the dip"),
      };
    },
  },

  {
    key: "SLOW_MOVING_STOCK",
    detect: ({ stock, today, booksStartedAt }) => {
      // Until the books are older than the window, "it has not moved in ninety
      // days" is not something they can establish about anything.
      const booksAge = daysBetween(booksStartedAt, today);
      if (booksAge < STALE_STOCK_DAYS) return null;

      const stillFor = (row: StockRow): number =>
        row.lastMovementAt
          ? Math.min(daysBetween(row.lastMovementAt, today), booksAge)
          : 0;

      const stale = stock.filter(
        (row) =>
          compare(row.quantity, 0) > 0 &&
          row.lastMovementAt !== null &&
          stillFor(row) >= STALE_STOCK_DAYS,
      );
      if (stale.length === 0) return null;

      const value = add(...stale.map((row) => row.stockValue));
      if (compare(value, MINIMUM_AMOUNT) < 0) return null;

      const longest = Math.max(...stale.map(stillFor));

      return {
        observation:
          `${stale.length} ${stale.length === 1 ? "line has" : "lines have"} not moved in ` +
          `${STALE_STOCK_DAYS} days or more, holding ${rupees(value)} at what it cost. ` +
          `The longest has been still for ${longest} days.`,
        evidence: {
          lines: stale.length,
          valueAtCost: toStorageString(value),
          longestStillDays: longest,
          examples: stale
            .slice(0, 3)
            .map((row) => row.name)
            .join(", "),
        },
        // What it cost is in the books. What it would fetch today is not, so
        // the amount is stated as cash tied up rather than as a recovery.
        impact: recorded(value, "tied up in stock that is not moving"),
      };
    },
  },

  {
    key: "STOCK_OUT_RISK",
    detect: ({ stock, today }) => {
      /**
       * A line the shop actually stocks.
       *
       * An empty shelf is only worth mentioning where somebody meant to keep
       * something on it. A product sits at "OUT" the moment its quantity
       * reaches nil, whether or not a reorder level was ever set — so a
       * catalogue full of lines the shop has stopped selling used to produce
       * "twelve lines are at or below the reorder level you set", about twelve
       * products where no level was set and none is wanted. It said that on
       * every visit, forever, because a discontinued product stays at nil.
       *
       * Intent is read two ways: a reorder level the owner entered, or recent
       * trade in the line. The second window is the same one the slow-moving
       * check uses, so between them every held line is either moving or not.
       */
      const stocked = (row: StockRow): boolean => {
        if (compare(row.minStockLevel, 0) > 0) return true;
        return (
          row.lastMovementAt !== null &&
          daysBetween(row.lastMovementAt, today) < STALE_STOCK_DAYS
        );
      };

      const short = stock.filter((row) => row.status !== "OK" && stocked(row));
      if (short.length === 0) return null;

      const out = short.filter((row) => row.status === "OUT");
      const belowLevel = short.filter((row) => row.status === "LOW");

      // Said in terms of what is true of these particular lines. Claiming a
      // reorder level for lines that have none is a small lie that costs the
      // whole page its credibility.
      const observation =
        belowLevel.length > 0 && out.length > 0
          ? `${belowLevel.length} ${belowLevel.length === 1 ? "line is" : "lines are"} at or below the reorder level you set, and ` +
            `${out.length} ${out.length === 1 ? "line you have been selling is" : "lines you have been selling are"} out entirely.`
          : belowLevel.length > 0
            ? `${belowLevel.length} ${belowLevel.length === 1 ? "line is" : "lines are"} at or below the reorder level you set.`
            : `${out.length} ${out.length === 1 ? "line you have been selling is" : "lines you have been selling are"} out of stock.`;

      return {
        observation,
        evidence: {
          lines: short.length,
          out: out.length,
          belowReorderLevel: belowLevel.length,
          examples: short
            .slice(0, 3)
            .map((row) => row.name)
            .join(", "),
        },
        // A sale that did not happen leaves no trace in any ledger. Putting a
        // figure on it would mean inventing the customers who turned round and
        // walked out, and this software never saw them.
        impact: unquantified(
          "what an empty shelf costs, because a sale that did not happen is not recorded anywhere",
        ),
      };
    },
  },

  {
    key: "LOW_MARGIN_PRODUCT",
    detect: ({ analytics }) => {
      const revenue = money(analytics.revenue.current);
      const grossProfit = money(analytics.grossProfit.current);
      const average = percent(grossProfit, revenue);
      if (average === null) return null;

      const laggards = analytics.products.filter(
        (product) =>
          product.marginPercent !== null &&
          product.sharePercent >= MATERIAL_PRODUCT_SHARE_PERCENT &&
          product.marginPercent <= average - MARGIN_GAP_POINTS,
      );
      if (laggards.length === 0) return null;

      // What the same sales would have earned at the shop's own average
      // margin. An assumption, stated as one, and widened into a band.
      const gap = add(
        ...laggards.map((product) =>
          multiply(
            money(product.revenue),
            divide(subtract(average, product.marginPercent ?? 0), 100),
          ),
        ),
      );
      if (compare(gap, MINIMUM_AMOUNT) < 0) return null;

      return {
        observation:
          `${laggards.length} ${laggards.length === 1 ? "line earns" : "lines earn"} noticeably less than the rest of what you sell. ` +
          `Your average margin this period is ${average}%.`,
        evidence: {
          lines: laggards.length,
          averageMarginPercent: average,
          examples: laggards
            .slice(0, 3)
            .map(
              (product) => `${product.name} at ${product.marginPercent ?? 0}%`,
            )
            .join(", "),
        },
        impact: estimated(
          gap,
          "if those lines earned the same margin as the rest of your sales, at the same volume",
        ),
      };
    },
  },

  {
    key: "MARGIN_SLIPPING",
    detect: ({ analytics }) => {
      const revenue = money(analytics.revenue.current);
      const previousRevenue = money(analytics.revenue.previous);
      if (
        compare(revenue, 0) <= 0 ||
        compare(previousRevenue, MINIMUM_AMOUNT) < 0
      ) {
        return null;
      }

      const now = percent(money(analytics.grossProfit.current), revenue);
      const before = percent(
        money(analytics.grossProfit.previous),
        previousRevenue,
      );
      if (now === null || before === null) return null;

      const drop = Number((before - now).toFixed(1));
      if (drop < MARGIN_DROP_POINTS) return null;

      return {
        observation:
          `Gross margin is ${now}% this period against ${before}% in the ${analytics.days} days before it — ` +
          `${drop} points lower on the same measure.`,
        evidence: {
          marginPercent: now,
          previousMarginPercent: before,
          dropPoints: drop,
          comparedWith: `${analytics.previousFrom} to ${analytics.previousTo}`,
        },
        impact: estimated(
          multiply(revenue, divide(drop, 100)),
          "if this period's sales had earned the earlier margin",
        ),
      };
    },
  },

  {
    key: "CUSTOMER_CONCENTRATION",
    detect: ({ analytics }) => {
      // The threshold lives in the analytics service, which already decides
      // when concentration is a fact worth stating. Repeating the rule here
      // would give the two pages room to disagree.
      if (!analytics.concentration.note) return null;

      return {
        observation: analytics.concentration.note,
        evidence: {
          topCustomer: analytics.concentration.topName ?? "—",
          topSharePercent: analytics.concentration.topSharePercent ?? 0,
          topFiveSharePercent: analytics.concentration.topFiveSharePercent ?? 0,
        },
        impact: unquantified(
          "what losing them would cost, which depends on whether they are going anywhere",
        ),
      };
    },
  },

  {
    key: "EXPENSE_GROWING_FASTER_THAN_SALES",
    detect: ({ analytics }) => {
      const expenseGrowth = analytics.operatingExpenses.changePercent;
      const revenueGrowth = analytics.revenue.changePercent;
      if (expenseGrowth === null || revenueGrowth === null) return null;
      if (compare(analytics.operatingExpenses.current, MINIMUM_AMOUNT) < 0) {
        return null;
      }

      const gap = Number((expenseGrowth - revenueGrowth).toFixed(1));
      if (gap < EXPENSE_GROWTH_GAP_POINTS) return null;

      return {
        observation:
          `Running costs are ${expenseGrowth}% up on the previous ${analytics.days} days while sales are ` +
          `${revenueGrowth >= 0 ? "up" : "down"} ${Math.abs(revenueGrowth)}%.`,
        evidence: {
          expenseGrowthPercent: expenseGrowth,
          revenueGrowthPercent: revenueGrowth,
          expenses: analytics.operatingExpenses.current,
          previousExpenses: analytics.operatingExpenses.previous,
        },
        // The change is recorded; whether it should be reversed is not.
        impact: recorded(
          money(analytics.operatingExpenses.change),
          "more spent than in the period before",
        ),
      };
    },
  },

  {
    key: "SHORT_ON_WORKING_CAPITAL",
    detect: ({ analytics }) => {
      const ratio = analytics.ratios.find(
        (entry) => entry.key === "currentRatio",
      );
      if (!ratio || ratio.value === null || ratio.value >= 1) return null;

      return {
        observation: `Short-term liabilities come to more than short-term assets: the current ratio is ${ratio.value}.`,
        evidence: { currentRatio: ratio.value },
        // The gap is arithmetic, but calling it a shortfall would assume every
        // current liability is really due next month, and an owner's loan
        // sitting in that total is not.
        impact: unquantified(
          "the size of the gap, which depends on which of those liabilities are genuinely due soon",
        ),
      };
    },
  },

  {
    key: "CASH_TIED_UP_TOO_LONG",
    detect: ({ analytics }) => {
      const cycle = analytics.ratios.find((entry) => entry.key === "cashCycle");
      if (!cycle || cycle.value === null || cycle.value <= LONG_CASH_CYCLE_DAYS)
        return null;

      const costOfSales = subtract(
        money(analytics.revenue.current),
        money(analytics.grossProfit.current),
      );
      if (compare(costOfSales, 0) <= 0) return null;

      const perDay = divide(costOfSales, analytics.days);

      return {
        observation:
          `Cash spends about ${Math.round(cycle.value)} days as stock and unpaid invoices before it comes back — ` +
          `stock in, sold, and collected.`,
        evidence: {
          cashCycleDays: Math.round(cycle.value),
          costOfSales: toStorageString(costOfSales),
          periodDays: analytics.days,
        },
        impact: estimated(
          multiply(perDay, CYCLE_IMPROVEMENT_DAYS),
          `for each week off the cycle, at the rate you have been buying and selling`,
        ),
      };
    },
  },
];

/**
 * Everything the books support saying, in the order it is worth reading.
 *
 * A detector that finds nothing returns nothing. There is no minimum number of
 * suggestions and nothing is padded out to fill the page: a shop with nothing
 * to fix should be told that, not handed three vague ideas so the screen looks
 * busy.
 *
 * A detector that *throws* takes out its own suggestion and nothing else, and
 * is named in `failed` so the page can say which. The service already goes to
 * some trouble to survive a source it cannot read; without the same care here,
 * one detector meeting a shape it did not expect would throw all of that away
 * and return an error page instead of the nine suggestions that were fine.
 */
export function detect(inputs: AdvisorInputs): {
  suggestions: Suggestion[];
  failed: SuggestionKey[];
} {
  const suggestions: Suggestion[] = [];
  const failed: SuggestionKey[] = [];

  for (const detector of DETECTORS) {
    try {
      const found = detector.detect(inputs);
      if (!found) continue;

      const { urgency, escalated } = urgencyFor({
        key: detector.key,
        impact: found.impact,
        periodRevenue: inputs.analytics.revenue.current,
      });

      suggestions.push({ key: detector.key, ...found, urgency, escalated });
    } catch {
      failed.push(detector.key);
    }
  }

  return { suggestions, failed };
}
