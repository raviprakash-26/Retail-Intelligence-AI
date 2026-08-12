import { describe, expect, it } from "vitest";
import {
  BAND_LABELS,
  computeHealth,
  HEALTH_DISCLAIMER,
  MINIMUM_COMPONENTS,
} from "@/lib/analytics/health";
import { computeRatios, type RatioInputs } from "@/lib/analytics/ratios";

/**
 * The health indicator.
 *
 * Two things are being protected here. The score has to be reproducible by
 * hand — every component states its rule and the figure it was applied to — and
 * a business with too little trading has to get no score rather than a low one,
 * because scoring missing data is a judgement about the data.
 */

const healthy: RatioInputs = {
  days: 365,
  revenue: 1_000_000,
  costOfSales: 700_000,
  grossProfit: 300_000,
  operatingExpenses: 150_000,
  netProfit: 150_000,
  purchases: 750_000,
  openingInventory: 100_000,
  closingInventory: 140_000,
  receivables: 40_000,
  payables: 90_000,
  currentAssets: 500_000,
  currentLiabilities: 200_000,
  equity: 500_000,
};

const healthOf = (inputs: Partial<RatioInputs> = {}) =>
  computeHealth(computeRatios({ ...healthy, ...inputs }));

describe("what it is not", () => {
  it("carries a disclaimer that says it is not a credit score", () => {
    // Kept beside the computation rather than in a component, so a second
    // place that shows the score cannot show it without the caveat.
    expect(HEALTH_DISCLAIMER).toMatch(/not a credit score/i);
    expect(HEALTH_DISCLAIMER).toMatch(/no lender sees it/i);
    expect(HEALTH_DISCLAIMER).toMatch(/no bearing on any loan/i);
  });
});

describe("scoring", () => {
  it("scores a well-run shop highly", () => {
    const health = healthOf();
    expect(health.score).not.toBeNull();
    expect(health.score ?? 0).toBeGreaterThanOrEqual(70);
    expect(health.band).toBe("strong");
  });

  it("scores a shop under strain low", () => {
    const health = healthOf({
      netProfit: -80_000,
      operatingExpenses: 380_000,
      currentAssets: 120_000,
      currentLiabilities: 300_000,
      receivables: 300_000,
      closingInventory: 500_000,
      openingInventory: 500_000,
    });
    expect(health.score ?? 100).toBeLessThan(45);
    expect(health.band).toBe("strained");
  });

  it("stays inside 0 and 100 however extreme the inputs", () => {
    const extremes: Array<Partial<RatioInputs>> = [
      { netProfit: 900_000, receivables: 0, currentLiabilities: 1 },
      { netProfit: -900_000, receivables: 900_000, currentAssets: 1 },
    ];
    for (const inputs of extremes) {
      const health = healthOf(inputs);
      expect(health.score ?? 0).toBeGreaterThanOrEqual(0);
      expect(health.score ?? 0).toBeLessThanOrEqual(100);
    }
  });

  it("can be re-derived by hand from what it shows", () => {
    // The whole argument for showing a composite at all: a reader can check it.
    const health = healthOf();
    const measured = health.components.filter((entry) => entry.score !== null);
    const weight = measured.reduce((sum, entry) => sum + entry.weight, 0);
    const expected = Math.round(
      measured.reduce(
        (sum, entry) => sum + (entry.score ?? 0) * entry.weight,
        0,
      ) / weight,
    );
    expect(health.score).toBe(expected);
  });

  it("states a rule and an observation for every component", () => {
    for (const component of healthOf().components) {
      expect(component.rule.length).toBeGreaterThan(20);
      expect(component.observed.length).toBeGreaterThan(0);
      expect(component.weight).toBeGreaterThan(0);
    }
  });

  it("weights the five components to a hundred", () => {
    const total = healthOf().components.reduce(
      (sum, entry) => sum + entry.weight,
      0,
    );
    expect(total).toBe(100);
  });
});

describe("refusing to score", () => {
  it("says nothing at all when almost nothing is measurable", () => {
    const health = computeHealth(
      computeRatios({
        days: 20,
        revenue: 0,
        costOfSales: 0,
        grossProfit: 0,
        operatingExpenses: 0,
        netProfit: 0,
        purchases: 0,
        openingInventory: 0,
        closingInventory: 0,
        receivables: 0,
        payables: 0,
        currentAssets: 0,
        currentLiabilities: 0,
        equity: 0,
      }),
    );

    expect(health.score).toBeNull();
    expect(health.band).toBeNull();
    expect(health.measured).toBeLessThan(MINIMUM_COMPONENTS);
    expect(health.unavailable).toMatch(/not enough trading/i);
  });

  it("still lists the components it could not score, with the reason", () => {
    const health = computeHealth(
      computeRatios({ ...healthy, revenue: 0, grossProfit: 0, netProfit: 0 }),
    );
    const unscored = health.components.filter((entry) => entry.score === null);
    expect(unscored.length).toBeGreaterThan(0);
    for (const component of unscored) {
      expect(component.observed).toMatch(/not measurable/i);
    }
  });

  it("renormalises over the components it could measure", () => {
    // A shop with no stock at either end loses that component; the remaining
    // four have to still add to a score out of 100 rather than out of 85.
    const health = healthOf({ openingInventory: 0, closingInventory: 0 });
    expect(health.measured).toBe(4);
    expect(health.score ?? 0).toBeGreaterThan(0);
    expect(health.score ?? 0).toBeLessThanOrEqual(100);
  });
});

describe("bands", () => {
  it("names every band it can return", () => {
    for (const band of ["strong", "steady", "strained"] as const) {
      expect(BAND_LABELS[band].length).toBeGreaterThan(0);
    }
  });

  it("moves the band with the score, in one direction", () => {
    // Better books never produce a worse band.
    const strong = healthOf().score ?? 0;
    const weaker = healthOf({ netProfit: 20_000 }).score ?? 0;
    expect(strong).toBeGreaterThan(weaker);
  });
});
