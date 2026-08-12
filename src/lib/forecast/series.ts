/**
 * Forecasting a series, and refusing to.
 *
 * **A forecast is a range, never a figure.** "Revenue will be ₹5,42,300" is a
 * sentence no honest model can produce, and printing it invites decisions the
 * arithmetic does not support. Everything here comes back as a band, the band
 * is drawn from how far the actual history fell from the fitted line, and where
 * the band is so wide that it says nothing the result refuses to be a forecast
 * at all.
 *
 * The method is deliberately the simplest one that carries an honest error
 * estimate: ordinary least squares through the observed periods, with a
 * textbook prediction interval that widens the further out it reaches. It is
 * explainable in one sentence to the person whose business it is, which a
 * gradient-boosted anything is not.
 *
 * No model produced any of this. Nothing here is an LLM's opinion; later phases
 * may narrate these numbers in words, but they will not change them.
 */

export type Observation = {
  /** ISO date of the period start. */
  start: string;
  value: number;
};

export type ForecastPoint = {
  start: string;
  point: number;
  lower: number;
  upper: number;
};

export type ForecastResult = {
  method: string;
  /** What was fitted and how the band was drawn, in words. */
  explanation: string;
  points: ForecastPoint[];
  /** How many historical periods went into it. */
  observations: number;
  /** Confidence level of the band, as a fraction. */
  level: number;
  /**
   * Mean width of the band as a multiple of the point. Higher is vaguer; the
   * interface leads with this rather than burying it.
   */
  spread: number | null;
  /** True where the band is so wide the numbers should not be leaned on. */
  tooUncertain: boolean;
  /** What this cannot see, stated every time. */
  limitations: string[];
  /** Set when no forecast was produced at all, with the reason. */
  unavailable: string | null;
};

/** Below this many periods, a line through the points is not a forecast. */
export const MINIMUM_OBSERVATIONS = 6;

/**
 * Where the band stops being informative.
 *
 * A range whose width is more than the figure itself — "somewhere between
 * ₹20,000 and ₹90,000" — is not a forecast a person can act on, and dressing it
 * up as one is the precise failure this module exists to avoid.
 */
export const TOO_UNCERTAIN_SPREAD = 1;

/** 80%, not 95%. A 95% band on a shop's weekly takings is so wide it says nothing. */
export const DEFAULT_LEVEL = 0.8;

/**
 * Two-tailed t values at 80% confidence, by degrees of freedom.
 *
 * A small table rather than a dependency: the only levels this module offers
 * are the ones a business forecast is readable at, and the values stop moving
 * meaningfully past thirty observations.
 */
const T_80: Record<number, number> = {
  1: 3.078,
  2: 1.886,
  3: 1.638,
  4: 1.533,
  5: 1.476,
  6: 1.44,
  7: 1.415,
  8: 1.397,
  9: 1.383,
  10: 1.372,
  12: 1.356,
  15: 1.341,
  20: 1.325,
  25: 1.316,
  30: 1.31,
};

function tValue(degreesOfFreedom: number): number {
  if (degreesOfFreedom >= 30) return 1.282;
  const keys = Object.keys(T_80)
    .map(Number)
    .sort((a, b) => a - b);
  for (const key of keys) {
    if (degreesOfFreedom <= key) return T_80[key]!;
  }
  return 1.282;
}

export type FitOptions = {
  /** How many periods ahead to project. */
  horizon: number;
  /** Days between one period start and the next. */
  periodDays: number;
  /** Values that cannot go below zero — revenue, quantities. */
  nonNegative?: boolean;
  level?: number;
};

const DAY = 86_400_000;

function addDays(start: string, days: number): string {
  const date = new Date(`${start}T00:00:00.000Z`);
  return new Date(date.getTime() + days * DAY).toISOString().slice(0, 10);
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The limitations that hold whatever the data looks like. */
function baseLimitations(): string[] {
  return [
    "This is a straight line through what has already happened. It assumes the next few periods look like the last several, which a festival, a new competitor or a price change would each break.",
    "There is no seasonal adjustment. A shop whose Diwali is far bigger than its March will not see that pattern here.",
  ];
}

/**
 * Fits a trend and projects it forward with a prediction interval.
 *
 * Returns a refusal rather than a forecast when there is too little history to
 * fit anything, because six weeks of guessing presented as a projection is
 * worse than an empty panel that says why it is empty.
 */
export function forecastSeries(
  history: readonly Observation[],
  options: FitOptions,
): ForecastResult {
  const level = options.level ?? DEFAULT_LEVEL;
  const observations = history.length;

  const empty = (unavailable: string): ForecastResult => ({
    method: "least_squares_trend_v1",
    explanation:
      "A straight line fitted through the periods already recorded, with a band drawn from how far those periods fell from the line.",
    points: [],
    observations,
    level,
    spread: null,
    tooUncertain: false,
    limitations: baseLimitations(),
    unavailable,
  });

  if (observations < MINIMUM_OBSERVATIONS) {
    return empty(
      `A forecast needs at least ${MINIMUM_OBSERVATIONS} periods of history to fit a line and an honest band. There ${observations === 1 ? "is" : "are"} ${observations}.`,
    );
  }

  const last = history[observations - 1];
  if (!last) return empty("There is no history to project from.");

  // Ordinary least squares on the period index.
  const xs = history.map((_, index) => index);
  const ys = history.map((point) => point.value);
  const meanX = xs.reduce((sum, x) => sum + x, 0) / observations;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / observations;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < observations; i += 1) {
    const dx = xs[i]! - meanX;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - meanY);
  }

  if (sxx === 0) {
    return empty("Every period in the history falls on the same date.");
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  // Residual standard error: how far the actual periods sat from the line. The
  // whole band comes from this, which is what makes it the shop's own
  // uncertainty rather than a number chosen to look reassuring.
  let sse = 0;
  for (let i = 0; i < observations; i += 1) {
    const fitted = intercept + slope * xs[i]!;
    const residual = ys[i]! - fitted;
    sse += residual * residual;
  }
  const standardError = Math.sqrt(sse / Math.max(1, observations - 2));
  const t = tValue(observations - 2);

  const limitations = baseLimitations();
  if (standardError === 0) {
    limitations.push(
      "Every past period fell exactly on the line, so the band reflects only that regularity. Real trading is never this even, and the band is almost certainly too narrow.",
    );
  }

  const points: ForecastPoint[] = [];
  for (let step = 1; step <= options.horizon; step += 1) {
    const x = observations - 1 + step;
    const fitted = intercept + slope * x;
    // The textbook prediction interval: it widens the further out it reaches,
    // which is the honest shape for a projection.
    const margin =
      t *
      standardError *
      Math.sqrt(1 + 1 / observations + ((x - meanX) * (x - meanX)) / sxx);

    const lower = options.nonNegative
      ? Math.max(0, fitted - margin)
      : fitted - margin;

    points.push({
      start: addDays(last.start, step * options.periodDays),
      point: round2(options.nonNegative ? Math.max(0, fitted) : fitted),
      lower: round2(lower),
      upper: round2(fitted + margin),
    });
  }

  if (options.nonNegative && points.some((entry) => entry.point === 0)) {
    limitations.push(
      "The trend runs to nil or below within this horizon. That is what the recent periods point at, not a prediction that trading stops.",
    );
  }

  const measurable = points.filter((entry) => entry.point > 0);
  const spread =
    measurable.length > 0
      ? round2(
          measurable.reduce(
            (sum, entry) => sum + (entry.upper - entry.lower) / entry.point,
            0,
          ) / measurable.length,
        )
      : null;

  const tooUncertain = spread !== null && spread > TOO_UNCERTAIN_SPREAD;
  if (tooUncertain) {
    limitations.push(
      "Past periods vary too much for this to narrow down usefully. Treat the range as the answer and the middle of it as meaningless.",
    );
  }

  return {
    method: "least_squares_trend_v1",
    explanation:
      "A straight line fitted through the periods already recorded, with a band drawn from how far those periods fell from the line. The band widens further out, because it should.",
    points,
    observations,
    level,
    spread,
    tooUncertain,
    limitations,
    unavailable: null,
  };
}

/**
 * The direction of travel, in words.
 *
 * Deliberately coarse. "Revenue is trending up 3.7% a week" reads as a fact
 * about the future; "the recent weeks trend upwards" reads as what it is.
 */
export function describeDirection(result: ForecastResult): string | null {
  if (result.unavailable || result.points.length === 0) return null;
  if (result.tooUncertain) {
    return "The recent periods are too uneven to say which way this is going.";
  }

  const first = result.points[0]!;
  const last = result.points[result.points.length - 1]!;
  const change = last.point - first.point;
  const relative = first.point > 0 ? Math.abs(change) / first.point : 0;

  if (relative < 0.05) return "The recent periods point at roughly flat.";
  return change > 0
    ? "The recent periods point upwards."
    : "The recent periods point downwards.";
}
