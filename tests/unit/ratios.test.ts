import { describe, expect, it } from "vitest";
import {
  annualise,
  computeRatios,
  formatRatio,
  type Ratio,
  type RatioInputs,
  type RatioKey,
} from "@/lib/analytics/ratios";

/**
 * Ratios, and the ones that refuse to exist.
 *
 * The arithmetic is the easy half. The half that matters is that a ratio which
 * cannot be computed honestly comes back as null with a reason, because "0
 * times" and "we cannot tell" look identical on a dashboard and mean opposite
 * things.
 */

const base: RatioInputs = {
  days: 365,
  revenue: 1_000_000,
  costOfSales: 700_000,
  grossProfit: 300_000,
  operatingExpenses: 200_000,
  netProfit: 100_000,
  purchases: 750_000,
  openingInventory: 100_000,
  closingInventory: 140_000,
  receivables: 120_000,
  payables: 90_000,
  currentAssets: 400_000,
  currentLiabilities: 200_000,
  equity: 500_000,
};

const of = (inputs: Partial<RatioInputs> = {}): Map<RatioKey, Ratio> => {
  const ratios = computeRatios({ ...base, ...inputs });
  return new Map(ratios.map((ratio) => [ratio.key, ratio]));
};

const value = (inputs: Partial<RatioInputs>, key: RatioKey) =>
  of(inputs).get(key)?.value ?? null;

describe("margins", () => {
  it("computes gross and net margin off revenue", () => {
    const ratios = of();
    expect(ratios.get("grossMargin")?.value).toBe(30);
    expect(ratios.get("netMargin")?.value).toBe(10);
    expect(ratios.get("expenseRatio")?.value).toBe(20);
  });

  it("has nothing to say when nothing was sold", () => {
    const ratios = of({ revenue: 0, grossProfit: 0, netProfit: 0 });
    for (const key of ["grossMargin", "netMargin", "expenseRatio"] as const) {
      expect(ratios.get(key)?.value).toBeNull();
      expect(ratios.get(key)?.unavailable).toMatch(/Nothing was sold/);
    }
  });

  it("says plainly when goods are sold below cost", () => {
    const ratios = of({ costOfSales: 1_200_000, grossProfit: -200_000 });
    expect(ratios.get("grossMargin")?.concern).toMatch(/less than they cost/i);
  });

  it("says plainly when the period made a loss", () => {
    const ratios = of({ netProfit: -50_000 });
    expect(ratios.get("netMargin")?.concern).toMatch(/made a loss/i);
  });

  it("flags running costs that the gross margin cannot cover", () => {
    // 40% of sales spent running the shop, on a 30% gross margin: the shop
    // cannot break even however many more of these sales it makes.
    const ratios = of({ operatingExpenses: 400_000, netProfit: -100_000 });
    expect(ratios.get("expenseRatio")?.concern).toMatch(/cannot break even/i);
  });

  it("does not flag costs comfortably inside the margin", () => {
    expect(of().get("expenseRatio")?.concern).toBeNull();
  });
});

describe("stock", () => {
  it("turns over against average stock, not closing stock", () => {
    // COGS 7,00,000 against an average of (1,00,000 + 1,40,000) / 2 = 1,20,000.
    expect(value({}, "inventoryTurnover")).toBeCloseTo(5.83, 2);
  });

  it("converts turnover into days on the shelf", () => {
    // 365 / 5.83 ≈ 62.6 days.
    expect(value({}, "inventoryDays")).toBeCloseTo(62.61, 1);
  });

  it("refuses to report turnover for a shop that holds no stock", () => {
    // A service business, or one that has not started. "0 times" would say the
    // stock never moves, which is the opposite of what is true.
    const ratios = of({ openingInventory: 0, closingInventory: 0 });
    expect(ratios.get("inventoryTurnover")?.value).toBeNull();
    expect(ratios.get("inventoryTurnover")?.unavailable).toMatch(/no stock/i);
    expect(ratios.get("inventoryDays")?.value).toBeNull();
  });

  it("scales with the length of the window", () => {
    // The same trading over a month gives the same turnover and a twelfth of
    // the days, because days of stock is a rate and turnover is a count.
    const year = of({ days: 365 });
    const month = of({ days: 30 });
    expect(month.get("inventoryTurnover")?.value).toBe(
      year.get("inventoryTurnover")?.value,
    );
    expect(month.get("inventoryDays")?.value ?? 0).toBeLessThan(
      year.get("inventoryDays")?.value ?? 0,
    );
  });
});

describe("collection and payment", () => {
  it("measures collection days against revenue", () => {
    // 1,20,000 owed on 10,00,000 of sales over 365 days = 43.8 days.
    expect(value({}, "receivableDays")).toBeCloseTo(43.8, 1);
  });

  it("measures payment days against purchases, not against sales", () => {
    // A shop that marks up heavily would look like a fast payer if this were
    // measured against revenue.
    expect(value({}, "payableDays")).toBeCloseTo(43.8, 1);
    expect(value({ purchases: 500_000 }, "payableDays")).toBeCloseTo(65.7, 1);
  });

  it("has no payment days when nothing was bought", () => {
    const ratios = of({ purchases: 0 });
    expect(ratios.get("payableDays")?.value).toBeNull();
    expect(ratios.get("payableDays")?.unavailable).toMatch(
      /Nothing was bought/,
    );
  });

  it("adds the three into a cash cycle", () => {
    const ratios = of();
    const expected =
      (ratios.get("inventoryDays")?.value ?? 0) +
      (ratios.get("receivableDays")?.value ?? 0) -
      (ratios.get("payableDays")?.value ?? 0);
    expect(ratios.get("cashCycle")?.value).toBeCloseTo(expected, 1);
  });

  it("goes negative where customers pay before suppliers do", () => {
    // The position a cash-and-carry shop on supplier credit is actually in.
    const cycle = value(
      {
        receivables: 0,
        payables: 400_000,
        closingInventory: 20_000,
        openingInventory: 20_000,
      },
      "cashCycle",
    );
    expect(cycle).toBeLessThan(0);
  });

  it("withholds the cycle when one of its three parts is missing", () => {
    const ratios = of({ purchases: 0 });
    expect(ratios.get("cashCycle")?.value).toBeNull();
    expect(ratios.get("cashCycle")?.unavailable).toMatch(
      /could not be computed/,
    );
  });
});

describe("the position", () => {
  it("computes current and quick ratios", () => {
    expect(value({}, "currentRatio")).toBe(2);
    // Without the 1,40,000 of stock: 2,60,000 against 2,00,000.
    expect(value({}, "quickRatio")).toBe(1.3);
  });

  it("says outright when short-term debts exceed short-term assets", () => {
    // Not a verdict on how the shop is run — it is what the number means.
    const ratios = of({ currentAssets: 150_000 });
    expect(ratios.get("currentRatio")?.concern).toMatch(/larger than/i);
  });

  it("flags a quick ratio under one separately", () => {
    // Comfortable on paper, only because the money is tied up in stock.
    const ratios = of({ closingInventory: 300_000 });
    expect(ratios.get("currentRatio")?.concern).toBeNull();
    expect(ratios.get("quickRatio")?.concern).toMatch(/without selling stock/i);
  });

  it("has no ratio at all when there are no short-term debts", () => {
    const ratios = of({ currentLiabilities: 0 });
    expect(ratios.get("currentRatio")?.value).toBeNull();
    expect(ratios.get("currentRatio")?.unavailable).toMatch(/no short-term/i);
  });

  it("returns nothing on capital that is nil or negative", () => {
    const ratios = of({ equity: 0 });
    expect(ratios.get("returnOnCapital")?.value).toBeNull();
    expect(ratios.get("returnOnCapital")?.unavailable).toMatch(
      /nil or negative/,
    );
  });

  it("computes a return where there is capital to return on", () => {
    expect(value({}, "returnOnCapital")).toBe(20);
  });
});

describe("presentation", () => {
  it("prints each unit in its own way", () => {
    const ratios = computeRatios(base);
    const shown = new Map(
      ratios.map((ratio) => [ratio.key, formatRatio(ratio)]),
    );
    expect(shown.get("grossMargin")).toBe("30.0%");
    expect(shown.get("currentRatio")).toBe("2.00");
    expect(shown.get("inventoryTurnover")).toBe("5.8×");
    expect(shown.get("receivableDays")).toBe("44 days");
  });

  it("prints an em dash rather than a zero for what it cannot compute", () => {
    const ratios = computeRatios({ ...base, currentLiabilities: 0 });
    const current = ratios.find((ratio) => ratio.key === "currentRatio");
    expect(current && formatRatio(current)).toBe("—");
  });

  it("gives every ratio a meaning a shopkeeper would use", () => {
    for (const ratio of computeRatios(base)) {
      expect(ratio.meaning.length).toBeGreaterThan(20);
      expect(ratio.label.length).toBeGreaterThan(0);
    }
  });

  it("annualises a figure measured over a shorter window", () => {
    expect(annualise(1, 365)).toBe(1);
    expect(annualise(1, 30)).toBeCloseTo(12.17, 2);
    // A zero-length window cannot be scaled, and returning Infinity would be
    // worse than returning the figure unchanged.
    expect(annualise(5, 0)).toBe(5);
  });
});

describe("degenerate inputs", () => {
  it("survives a period in which nothing at all happened", () => {
    const ratios = computeRatios({
      days: 30,
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
    });

    // Every one of them null, every one of them with a reason, and not a
    // single zero anywhere.
    expect(ratios.every((ratio) => ratio.value === null)).toBe(true);
    expect(ratios.every((ratio) => ratio.unavailable !== null)).toBe(true);
  });

  it("treats a zero-day window as one day rather than dividing by nothing", () => {
    const ratios = computeRatios({ ...base, days: 0 });
    expect(
      Number.isFinite(
        ratios.find((r) => r.key === "receivableDays")?.value ?? NaN,
      ),
    ).toBe(true);
  });
});
