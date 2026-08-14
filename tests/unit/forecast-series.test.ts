import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEVEL,
  describeDirection,
  forecastSeries,
  MINIMUM_OBSERVATIONS,
  TOO_UNCERTAIN_SPREAD,
  type Observation,
} from "@/lib/forecast/series";

/**
 * Forecasting, and refusing to.
 *
 * The arithmetic is checkable — a perfectly straight history has to project
 * straight on — but the tests that matter are the ones about restraint: too
 * little history produces a refusal rather than a guess, and a history too
 * uneven to narrow down says so instead of putting a confident number in the
 * middle of a useless range.
 */

const weekly = (values: number[], start = "2026-01-05"): Observation[] =>
  values.map((value, index) => ({
    start: new Date(
      new Date(`${start}T00:00:00.000Z`).getTime() + index * 7 * 86_400_000,
    )
      .toISOString()
      .slice(0, 10),
    value,
  }));

const forecast = (values: number[], horizon = 4) =>
  forecastSeries(weekly(values), {
    horizon,
    periodDays: 7,
    nonNegative: true,
  });

describe("refusing to forecast", () => {
  it("needs a minimum of history before it will fit anything", () => {
    const result = forecast([100, 110, 120]);
    expect(result.points).toHaveLength(0);
    expect(result.unavailable).toMatch(/at least 6 periods/i);
    expect(result.observations).toBe(3);
  });

  it("takes the fit as soon as it has enough", () => {
    const short = forecast(new Array(MINIMUM_OBSERVATIONS - 1).fill(100));
    const enough = forecast(new Array(MINIMUM_OBSERVATIONS).fill(100));
    expect(short.unavailable).not.toBeNull();
    expect(enough.unavailable).toBeNull();
  });

  it("says nothing at all when there is no history", () => {
    const result = forecastSeries([], { horizon: 4, periodDays: 7 });
    expect(result.points).toHaveLength(0);
    expect(result.unavailable).not.toBeNull();
  });
});

describe("the shape of the projection", () => {
  it("carries a rising trend forward", () => {
    const result = forecast([100, 120, 140, 160, 180, 200, 220, 240]);
    expect(result.unavailable).toBeNull();
    expect(result.points).toHaveLength(4);
    // The line rises by 20 a week and the projection keeps rising by 20.
    expect(result.points[0]?.point).toBeCloseTo(260, 0);
    expect(result.points[3]?.point).toBeCloseTo(320, 0);
  });

  it("carries a falling trend forward too", () => {
    const result = forecast([240, 220, 200, 180, 160, 140]);
    expect(result.points[0]?.point).toBeCloseTo(120, 0);
    expect(describeDirection(result)).toMatch(/downwards/i);
  });

  it("dates each projected period a whole period after the last", () => {
    // Six weekly points from Monday 5 January 2026 end on 9 February, so the
    // first projected week is the one beginning 16 February.
    const result = forecast([10, 20, 30, 40, 50, 60]);
    expect(result.points[0]?.start).toBe("2026-02-16");
    expect(result.points[1]?.start).toBe("2026-02-23");
  });

  it("never puts a projection below nil where the figure cannot be negative", () => {
    const result = forecast([600, 500, 400, 300, 200, 100]);
    for (const point of result.points) {
      expect(point.point).toBeGreaterThanOrEqual(0);
      expect(point.lower).toBeGreaterThanOrEqual(0);
    }
    expect(result.limitations.join(" ")).toMatch(/runs to nil/i);
  });

  it("lets a figure that can go negative do so", () => {
    // A cash projection has to be allowed to show an overdraft.
    const result = forecastSeries(weekly([600, 500, 400, 300, 200, 100]), {
      horizon: 4,
      periodDays: 7,
    });
    expect(result.points[3]?.point).toBeLessThan(0);
  });
});

describe("the band", () => {
  it("always brackets the projection", () => {
    const result = forecast([100, 130, 90, 150, 120, 160, 140, 170]);
    for (const point of result.points) {
      expect(point.lower).toBeLessThanOrEqual(point.point);
      expect(point.upper).toBeGreaterThanOrEqual(point.point);
    }
  });

  it("widens the further out it reaches", () => {
    // The honest shape for a projection: next week is knowable, six weeks out
    // is much less so.
    const result = forecast([100, 130, 90, 150, 120, 160, 140, 170], 6);
    const widths = result.points.map((point) => point.upper - point.lower);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
    }
  });

  it("is drawn from how far the history fell from the line", () => {
    // The same trend, one steady and one erratic. The erratic shop gets the
    // wider band, because the band is its own variability and nothing else.
    const steady = forecast([100, 110, 120, 130, 140, 150, 160, 170]);
    const erratic = forecast([10, 200, 40, 240, 80, 260, 120, 300]);

    const width = (result: ReturnType<typeof forecast>) =>
      result.points[0]!.upper - result.points[0]!.lower;

    expect(width(erratic)).toBeGreaterThan(width(steady) * 5);
  });

  it("reports 80% rather than 95%", () => {
    // A 95% band on a shop's weekly takings is so wide it says nothing.
    expect(forecast([1, 2, 3, 4, 5, 6]).level).toBe(DEFAULT_LEVEL);
    expect(DEFAULT_LEVEL).toBe(0.8);
  });
});

describe("no fake precision", () => {
  it("marks a history too uneven to narrow down", () => {
    const result = forecast([10, 400, 20, 380, 5, 420, 15, 390]);
    expect(result.tooUncertain).toBe(true);
    expect(result.spread ?? 0).toBeGreaterThan(TOO_UNCERTAIN_SPREAD);
    expect(result.limitations.join(" ")).toMatch(
      /middle of it as meaningless/i,
    );
  });

  it("refuses to name a direction when it cannot see one", () => {
    const result = forecast([10, 400, 20, 380, 5, 420, 15, 390]);
    expect(describeDirection(result)).toMatch(/too uneven/i);
  });

  it("does not mark a steady history as uncertain", () => {
    const result = forecast([100, 105, 110, 115, 120, 125, 130, 135]);
    expect(result.tooUncertain).toBe(false);
    expect(result.spread ?? 99).toBeLessThan(TOO_UNCERTAIN_SPREAD);
  });

  it("admits when the history is suspiciously perfect", () => {
    // Every point exactly on the line gives a band of nothing, which would be
    // the most overconfident output the module could produce.
    const result = forecast([100, 200, 300, 400, 500, 600]);
    expect(result.limitations.join(" ")).toMatch(
      /almost certainly too narrow/i,
    );
  });

  it("always states what it cannot see", () => {
    const result = forecast([100, 120, 140, 160, 180, 200]);
    const text = result.limitations.join(" ");
    expect(text).toMatch(/straight line through what has already happened/i);
    expect(text).toMatch(/no seasonal adjustment/i);
    // And the refusal case keeps them too.
    expect(forecast([1, 2]).limitations.length).toBeGreaterThan(0);
  });

  it("describes the direction in words rather than a rate", () => {
    // "Trending up 3.7% a week" reads as a fact about the future.
    const rising = describeDirection(forecast([100, 120, 140, 160, 180, 200]));
    expect(rising).toMatch(/point upwards/i);
    expect(rising).not.toMatch(/\d/);

    const flat = describeDirection(forecast([100, 100, 100, 101, 100, 100]));
    expect(flat).toMatch(/roughly flat/i);
  });

  it("names its method so a later narration cannot claim another one", () => {
    expect(forecast([1, 2, 3, 4, 5, 6]).method).toBe("least_squares_trend_v1");
    expect(forecast([1, 2, 3, 4, 5, 6]).explanation).toMatch(
      /straight line fitted through/i,
    );
  });
});
