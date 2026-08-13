import "server-only";
import { prisma } from "@/lib/db";
import { CATALOGUE_VERSION } from "@/lib/advisor/catalogue";
import { rank, type Suggestion } from "@/lib/advisor/impact";
import type { RangeKey } from "@/lib/analytics/range";
import { getAnalytics } from "@/server/analytics/analytics-service";
import { getCashProjection } from "@/server/forecast/cash-projection";
import { HORIZON_WEEKS } from "@/server/forecast/forecast-service";
import { stockRows } from "@/server/inventory/inventory-report";
import { receivablesAgeing } from "@/server/settlements/outstanding";
import { detect } from "@/server/advisor/detectors";

/**
 * The advisor.
 *
 * It reads what the rest of the platform has already computed — the ageing, the
 * cash projection, the analytics report, the stock positions — and applies a
 * fixed set of detectors to it. Nothing is stored: a suggestion is a function
 * of today's books, and a stored one would go stale the moment somebody acted
 * on it and outlive the reason it existed.
 *
 * Everything is scoped to one company by the caller's session. The advisor
 * never sees a second set of books, and there is no parameter through which it
 * could be asked to.
 */

export type AdviceReport = {
  range: RangeKey;
  rangeLabel: string;
  from: string;
  to: string;
  suggestions: Suggestion[];
  catalogueVersion: string;
  /** True where the window contains no trading at all. */
  empty: boolean;
  /** Named where a source could not be read, rather than quietly missing. */
  incomplete: string[];
};

/**
 * A source that fails takes its own suggestions out, not the page.
 *
 * Advice assembled from four readings of the books should still be worth
 * something when three of them succeeded — as long as the page says which one
 * is missing, so nobody reads a short list as a clean bill of health.
 */
async function attempt<T>(
  name: string,
  read: () => Promise<T>,
  fallback: T,
  missing: string[],
): Promise<T> {
  try {
    return await read();
  } catch {
    missing.push(name);
    return fallback;
  }
}

export async function getAdvice(params: {
  companyId: string;
  range: RangeKey;
  fiscalYearStart: Date;
  fiscalYearEnd: Date;
  today?: Date;
}): Promise<AdviceReport> {
  const today = params.today ?? new Date();
  const incomplete: string[] = [];

  const analytics = await getAnalytics({
    companyId: params.companyId,
    range: params.range,
    fiscalYearStart: params.fiscalYearStart,
    fiscalYearEnd: params.fiscalYearEnd,
    today,
  });

  const [company, receivables, cash, stock] = await Promise.all([
    prisma.company.findUnique({
      where: { id: params.companyId },
      select: { createdAt: true },
    }),
    attempt(
      "what customers owe",
      () => receivablesAgeing(params.companyId),
      {
        summary: {
          total: "0",
          overdue: "0",
          buckets: {},
          oldestOverdueDays: null,
        },
        parties: [],
      },
      incomplete,
    ),
    attempt(
      "the cash projection",
      () =>
        getCashProjection({
          companyId: params.companyId,
          weeks: HORIZON_WEEKS,
          today,
        }),
      null,
      incomplete,
    ),
    attempt(
      "stock positions",
      () => stockRows(params.companyId),
      [],
      incomplete,
    ),
  ]);

  const suggestions = rank(
    detect({
      analytics,
      receivables,
      cash: cash ?? {
        from: "",
        to: "",
        openingCash: "0",
        weeks: [],
        firstShortfall: null,
        firstShortfallIfLate: null,
        weeklyRunningCost: "0",
        runningCostBasis: "",
        latenessDays: null,
        latenessBasis: "",
        overdueReceivables: "0",
        overduePayables: "0",
        limitations: [],
        unavailable: "The cash projection could not be read.",
      },
      stock,
      booksStartedAt: company?.createdAt ?? today,
      today,
    }),
  );

  return {
    range: analytics.range,
    rangeLabel: analytics.rangeLabel,
    from: analytics.from,
    to: analytics.to,
    suggestions,
    catalogueVersion: CATALOGUE_VERSION,
    empty: analytics.empty,
    incomplete,
  };
}
