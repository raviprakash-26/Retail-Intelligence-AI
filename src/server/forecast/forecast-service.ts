import "server-only";
import { toStorageString } from "@/lib/money";
import {
  describeDirection,
  forecastSeries,
  type ForecastResult,
  type Observation,
} from "@/lib/forecast/series";
import { revenueTrend } from "@/server/analytics/sales-analytics";
import {
  getCashProjection,
  type CashProjection,
} from "@/server/forecast/cash-projection";

/**
 * Forecasting.
 *
 * Two different things sit on one page, and the difference between them is
 * stated rather than blurred.
 *
 * **The revenue projection is a fit.** A line through the weeks already
 * recorded, with a band from how far those weeks fell from it. It can be wrong
 * in the ordinary way a trend is wrong, and where the shop's weeks vary too
 * much to narrow down it says so instead of putting a confident figure in the
 * middle of a useless range.
 *
 * **The cash projection is not a fit at all.** It rolls forward commitments
 * that already exist — invoices raised, bills received, and what the shop has
 * actually been spending to keep the lights on. Nothing is extrapolated, and
 * money from sales not yet made is deliberately absent.
 *
 * Nothing here is stored. A forecast written to a table is a forecast that goes
 * stale the moment the next invoice is posted, and a stale projection nobody
 * remembers generating is worse than one computed on the spot.
 */

export type SerialisedForecastPoint = {
  start: string;
  point: string;
  lower: string;
  upper: string;
};

export type SerialisedForecast = {
  method: string;
  explanation: string;
  points: SerialisedForecastPoint[];
  /** The weeks that went into the fit, for the chart to draw behind it. */
  history: SerialisedForecastPoint[];
  observations: number;
  level: number;
  spread: number | null;
  tooUncertain: boolean;
  direction: string | null;
  limitations: string[];
  unavailable: string | null;
};

export type ForecastReport = {
  /** Weeks of history read. */
  historyWeeks: number;
  /** Weeks projected forward. */
  horizonWeeks: number;
  revenue: SerialisedForecast;
  cash: CashProjection;
};

/** Half a year of weeks is enough to see a trend without chasing last year's. */
const HISTORY_WEEKS = 26;

/** Far enough to be useful, near enough that the band is still readable. */
const HORIZON_WEEKS = 8;

const DAY = 86_400_000;

function serialise(
  result: ForecastResult,
  history: readonly Observation[],
): SerialisedForecast {
  return {
    method: result.method,
    explanation: result.explanation,
    points: result.points.map((point) => ({
      start: point.start,
      point: toStorageString(point.point),
      lower: toStorageString(point.lower),
      upper: toStorageString(point.upper),
    })),
    // History is carried in the same shape with the band collapsed onto the
    // line, so the chart draws one series and the past is visibly certain.
    history: history.map((point) => ({
      start: point.start,
      point: toStorageString(point.value),
      lower: toStorageString(point.value),
      upper: toStorageString(point.value),
    })),
    observations: result.observations,
    level: result.level,
    spread: result.spread,
    tooUncertain: result.tooUncertain,
    direction: describeDirection(result),
    limitations: result.limitations,
    unavailable: result.unavailable,
  };
}

export async function getForecast(params: {
  companyId: string;
  today?: Date;
}): Promise<ForecastReport> {
  const today = params.today ?? new Date();
  const to = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const from = new Date(to.getTime() - HISTORY_WEEKS * 7 * DAY);

  const [trend, cash] = await Promise.all([
    // The same weekly series the analytics trend draws, read from the ledger,
    // so the history behind the projection is the history on that page.
    revenueTrend({
      companyId: params.companyId,
      from,
      to,
      granularity: "week",
    }),
    getCashProjection({
      companyId: params.companyId,
      weeks: HORIZON_WEEKS,
      today,
    }),
  ]);

  const history: Observation[] = trend.map((point) => ({
    start: point.start,
    value: Number(point.revenue),
  }));

  const revenue = forecastSeries(history, {
    horizon: HORIZON_WEEKS,
    periodDays: 7,
    nonNegative: true,
  });

  return {
    historyWeeks: HISTORY_WEEKS,
    horizonWeeks: HORIZON_WEEKS,
    revenue: serialise(revenue, history),
    cash,
  };
}
