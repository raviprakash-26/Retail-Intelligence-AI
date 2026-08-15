import { describe, expect, it } from "vitest";
import type {
  AnalyticsReport,
  Movement,
} from "@/server/analytics/analytics-service";
import type { CashProjection } from "@/server/forecast/cash-projection";
import type { StockRow } from "@/server/inventory/inventory-report";
import type { LedgerAgeing } from "@/server/settlements/outstanding";
import {
  detect,
  MARGIN_DROP_POINTS,
  MINIMUM_AMOUNT,
  STALE_STOCK_DAYS,
  type AdvisorInputs,
} from "@/server/advisor/detectors";

/**
 * The detectors, on books made up for the purpose.
 *
 * These are pure functions of figures computed elsewhere, so they can be asked
 * awkward questions directly: what happens on the first day of a business, what
 * happens when a threshold is missed by one, and what happens when the honest
 * answer is that there is no figure.
 */

const DAY = 86_400_000;
const TODAY = new Date("2026-08-13T00:00:00.000Z");
const daysAgo = (days: number): Date => new Date(TODAY.getTime() - days * DAY);

function movement(current: string, previous: string): Movement {
  const changePercent =
    Number(previous) > 0
      ? Number(
          (
            ((Number(current) - Number(previous)) / Number(previous)) *
            100
          ).toFixed(1),
        )
      : null;
  return {
    current,
    previous,
    change: String(Number(current) - Number(previous)),
    changePercent,
  };
}

function analytics(overrides: Partial<AnalyticsReport> = {}): AnalyticsReport {
  return {
    range: "fy",
    rangeLabel: "This financial year",
    from: "2026-04-01",
    to: "2026-08-13",
    days: 135,
    granularity: "week",
    previousFrom: "2025-11-17",
    previousTo: "2026-03-31",
    revenue: movement("1000000", "900000"),
    grossProfit: movement("300000", "270000"),
    netProfit: movement("100000", "90000"),
    operatingExpenses: movement("200000", "180000"),
    bills: { current: 400, previous: 380, changePercent: 5.3 },
    averageBill: movement("2500", "2368"),
    trend: [],
    products: [],
    customers: [],
    categories: [],
    weekdays: [],
    concentration: {
      topSharePercent: null,
      topName: null,
      topFiveSharePercent: null,
      note: null,
    },
    ratios: [],
    health: {
      score: null,
      band: null,
      components: [],
      measured: 0,
      unavailable: "No detector reads the indicator, so none is built here.",
    },
    empty: false,
    ...overrides,
  };
}

const NO_RECEIVABLES: LedgerAgeing = {
  summary: { total: "0", overdue: "0", buckets: {}, oldestOverdueDays: null },
  parties: [],
};

const NO_PAYABLES: LedgerAgeing = {
  summary: { total: "0", overdue: "0", buckets: {}, oldestOverdueDays: null },
  parties: [],
};

const NO_CASH_PROBLEM: CashProjection = {
  from: "2026-08-13",
  to: "2026-10-08",
  openingCash: "50000",
  weeks: [],
  firstShortfall: null,
  firstShortfallIfLate: null,
  weeklyRunningCost: "10000",
  runningCostBasis: "the last thirteen weeks",
  latenessDays: null,
  latenessBasis: "",
  overdueReceivables: "0",
  overduePayables: "0",
  limitations: [],
  unavailable: null,
};

function stockRow(overrides: Partial<StockRow> = {}): StockRow {
  return {
    productId: "p1",
    sku: "WIDGET",
    name: "Widget",
    unitCode: "PCS",
    categoryName: null,
    quantity: "100.0000",
    averageCost: "60.0000",
    stockValue: "6000.0000",
    sellingValue: "10000.0000",
    minStockLevel: "0.0000",
    status: "OK",
    lastMovementAt: daysAgo(2),
    ...overrides,
  };
}

function inputs(overrides: Partial<AdvisorInputs> = {}): AdvisorInputs {
  return {
    analytics: analytics(),
    receivables: NO_RECEIVABLES,
    payables: NO_PAYABLES,
    cash: NO_CASH_PROBLEM,
    stock: [],
    booksStartedAt: daysAgo(400),
    today: TODAY,
    ...overrides,
  };
}

const keys = (found: ReturnType<typeof detect>) =>
  found.suggestions.map((entry) => entry.key);

/** The suggestions alone, for the cases that do not care about failures. */
const only = (found: ReturnType<typeof detect>) => found.suggestions;

describe("stock that is sitting still", () => {
  const stale = stockRow({ lastMovementAt: daysAgo(200) });

  it("is noticed once it has been still long enough", () => {
    const found = detect(inputs({ stock: [stale] }));
    expect(keys(found)).toContain("SLOW_MOVING_STOCK");
  });

  it("is not noticed on a shop that opened last week", () => {
    // Opening stock is dated the first day of the financial year whatever day
    // it was entered. Without this the advisor greets every new business by
    // telling it that all of its stock is dead — which is how a page like this
    // gets ignored on day one and never read again.
    const found = detect(
      inputs({ stock: [stale], booksStartedAt: daysAgo(7) }),
    );
    expect(keys(found)).not.toContain("SLOW_MOVING_STOCK");
  });

  it("never claims stock has been still longer than the books have existed", () => {
    const found = detect(
      inputs({
        stock: [stockRow({ lastMovementAt: daysAgo(900) })],
        booksStartedAt: daysAgo(120),
      }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "SLOW_MOVING_STOCK",
    );
    expect(suggestion?.evidence.longestStillDays).toBe(120);
  });

  it("leaves a small holding alone", () => {
    const found = detect(
      inputs({
        stock: [stockRow({ lastMovementAt: daysAgo(200), stockValue: "40" })],
      }),
    );
    expect(keys(found)).not.toContain("SLOW_MOVING_STOCK");
    expect(MINIMUM_AMOUNT).toBe(1_000);
  });

  it("ignores a line that is out of stock, which is a different problem", () => {
    const found = detect(
      inputs({
        stock: [
          stockRow({
            quantity: "0.0000",
            stockValue: "0.0000",
            lastMovementAt: daysAgo(STALE_STOCK_DAYS + 10),
          }),
        ],
      }),
    );
    expect(keys(found)).not.toContain("SLOW_MOVING_STOCK");
  });
});

describe("a shelf about to be empty", () => {
  it("puts no figure on a sale that did not happen", () => {
    const found = detect(
      inputs({ stock: [stockRow({ status: "LOW", minStockLevel: "200" })] }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "STOCK_OUT_RISK",
    );
    expect(suggestion?.impact.kind).toBe("unquantified");
  });
});

describe("margin", () => {
  it("is reported when it falls by more than the threshold", () => {
    const found = detect(
      inputs({
        analytics: analytics({
          revenue: movement("1000000", "1000000"),
          // 30% before, 25% now.
          grossProfit: movement("250000", "300000"),
        }),
      }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "MARGIN_SLIPPING",
    );
    expect(suggestion?.evidence.dropPoints).toBe(5);
  });

  it("is left alone when it moves by less", () => {
    const found = detect(
      inputs({
        analytics: analytics({
          revenue: movement("1000000", "1000000"),
          grossProfit: movement("299000", "300000"),
        }),
      }),
    );
    expect(keys(found)).not.toContain("MARGIN_SLIPPING");
    expect(MARGIN_DROP_POINTS).toBe(3);
  });

  it("says nothing about a period with nothing to compare against", () => {
    const found = detect(
      inputs({
        analytics: analytics({
          revenue: movement("1000000", "0"),
          grossProfit: movement("250000", "0"),
        }),
      }),
    );
    expect(keys(found)).not.toContain("MARGIN_SLIPPING");
  });

  it("costs the slip as a band, not as a figure", () => {
    const found = detect(
      inputs({
        analytics: analytics({
          revenue: movement("1000000", "1000000"),
          grossProfit: movement("250000", "300000"),
        }),
      }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "MARGIN_SLIPPING",
    );
    if (suggestion?.impact.kind !== "estimated") {
      throw new Error("expected an estimate");
    }
    // 5 points of a million is 50,000 — stated as the band it is, with the
    // assumption that produced it.
    expect(suggestion.impact.low).toBe("35000.0000");
    expect(suggestion.impact.high).toBe("65000.0000");
    expect(suggestion.impact.assumption).toMatch(/earlier margin/);
  });
});

describe("costs against sales", () => {
  it("is reported when costs outrun sales by enough", () => {
    const found = detect(
      inputs({
        analytics: analytics({
          revenue: movement("1000000", "1000000"),
          operatingExpenses: movement("300000", "200000"),
        }),
      }),
    );
    expect(keys(found)).toContain("EXPENSE_GROWING_FASTER_THAN_SALES");
  });

  it("is not reported when both grew together", () => {
    const found = detect(
      inputs({
        analytics: analytics({
          revenue: movement("1200000", "1000000"),
          operatingExpenses: movement("240000", "200000"),
        }),
      }),
    );
    expect(keys(found)).not.toContain("EXPENSE_GROWING_FASTER_THAN_SALES");
  });
});

describe("concentration", () => {
  it("defers to the rule analytics already applies", () => {
    // Not repeated here. Two thresholds for one fact is two pages that can
    // disagree about it.
    const withNote = detect(
      inputs({
        analytics: analytics({
          concentration: {
            topSharePercent: 62,
            topName: "Sharma Provision Store",
            topFiveSharePercent: 90,
            note: "62% of revenue came from Sharma Provision Store.",
          },
        }),
      }),
    );
    expect(keys(withNote)).toContain("CUSTOMER_CONCENTRATION");
    expect(keys(detect(inputs()))).not.toContain("CUSTOMER_CONCENTRATION");
  });
});

describe("cash", () => {
  it("reports the dip on the on-time line as what is already committed", () => {
    const found = detect(
      inputs({
        cash: {
          ...NO_CASH_PROBLEM,
          firstShortfall: { start: "2026-09-07", amount: "-18000" },
        },
      }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "CASH_SHORTFALL_AHEAD",
    );
    expect(suggestion?.evidence.line).toBe("on time");
    if (suggestion?.impact.kind !== "recorded") {
      throw new Error("expected a recorded amount");
    }
    expect(suggestion.impact.amount).toBe("18000.0000");
  });

  it("says so when only the late line dips", () => {
    const found = detect(
      inputs({
        cash: {
          ...NO_CASH_PROBLEM,
          firstShortfallIfLate: { start: "2026-09-07", amount: "-4000" },
          latenessDays: 12,
        },
      }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "CASH_SHORTFALL_AHEAD",
    );
    expect(suggestion?.observation).toMatch(/On time, it does not/);
  });

  it("says nothing when the projection could not be drawn", () => {
    const found = detect(
      inputs({
        cash: {
          ...NO_CASH_PROBLEM,
          unavailable: "There is not enough history yet.",
          firstShortfall: { start: "2026-09-07", amount: "-18000" },
        },
      }),
    );
    expect(keys(found)).not.toContain("CASH_SHORTFALL_AHEAD");
  });
});

describe("what customers owe", () => {
  it("states the overdue amount as recorded, not estimated", () => {
    const found = detect(
      inputs({
        receivables: {
          summary: {
            total: "80000",
            overdue: "48000",
            buckets: {},
            oldestOverdueDays: 61,
          },
          parties: [
            {
              id: "c1",
              name: "Sharma Provision Store",
              outstanding: "48000",
              overdue: "48000",
              oldestOverdueDays: 61,
            },
          ],
        },
      }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "OVERDUE_RECEIVABLES",
    );
    expect(suggestion?.impact).toEqual({
      kind: "recorded",
      amount: "48000.0000",
      what: "already earned and invoiced",
    });
    expect(suggestion?.observation).toMatch(/oldest by 61 days/);
  });

  it("does not interrupt anybody over small change", () => {
    const found = detect(
      inputs({
        receivables: {
          summary: {
            total: "500",
            overdue: "500",
            buckets: {},
            oldestOverdueDays: 3,
          },
          parties: [],
        },
      }),
    );
    expect(keys(found)).not.toContain("OVERDUE_RECEIVABLES");
  });
});

describe("the list as a whole", () => {
  it("is empty when the books show nothing worth saying", () => {
    expect(detect(inputs())).toEqual({ suggestions: [], failed: [] });
  });

  it("raises urgency for an amount large against this shop's turnover", () => {
    const found = detect(
      inputs({
        analytics: analytics({ revenue: movement("100000", "90000") }),
        receivables: {
          summary: {
            total: "60000",
            overdue: "60000",
            buckets: {},
            oldestOverdueDays: 40,
          },
          parties: [
            {
              id: "c1",
              name: "Sharma Provision Store",
              outstanding: "60000",
              overdue: "60000",
              oldestOverdueDays: 40,
            },
          ],
        },
      }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "OVERDUE_RECEIVABLES",
    );
    expect(suggestion?.urgency).toBe("NOW");
    expect(suggestion?.escalated).toBe(true);
  });
});

describe("lines the shop does not stock", () => {
  /** A catalogue line at nil with no reorder level and no recent trade. */
  const discontinued = (n: number) =>
    stockRow({
      productId: `p${n}`,
      name: `Discontinued ${n}`,
      quantity: "0.0000",
      stockValue: "0.0000",
      minStockLevel: "0.0000",
      status: "OUT",
      lastMovementAt: daysAgo(300),
    });

  it("are not reported as being below a reorder level nobody set", () => {
    // A product sits at OUT the moment its quantity reaches nil, whether or
    // not a level was ever set. The advisor used to count those and say
    // "N lines are at or below the reorder level you set" about lines where
    // none was set and none is wanted — on every visit, forever, because a
    // discontinued product stays at nil.
    const found = detect(
      inputs({ stock: [discontinued(1), discontinued(2), discontinued(3)] }),
    );
    expect(keys(found)).not.toContain("STOCK_OUT_RISK");
  });

  it("still reports a line the shop has been selling that ran out", () => {
    // The other half: an empty shelf on something actually in trade is the
    // whole point of the check, and no reorder level is needed to see it.
    const found = detect(
      inputs({
        stock: [
          discontinued(1),
          stockRow({
            productId: "p9",
            name: "Fast mover",
            quantity: "0.0000",
            minStockLevel: "0.0000",
            status: "OUT",
            lastMovementAt: daysAgo(3),
          }),
        ],
      }),
    );

    const suggestion = only(found).find(
      (entry) => entry.key === "STOCK_OUT_RISK",
    );
    expect(suggestion).toBeDefined();
    // One line, not two: the discontinued one is not counted.
    expect(suggestion?.evidence.lines).toBe(1);
    expect(suggestion?.evidence.examples).toBe("Fast mover");
  });

  it("does not claim a reorder level in the sentence when none was set", () => {
    const found = detect(
      inputs({
        stock: [
          stockRow({
            quantity: "0.0000",
            minStockLevel: "0.0000",
            status: "OUT",
            lastMovementAt: daysAgo(3),
          }),
        ],
      }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "STOCK_OUT_RISK",
    );
    expect(suggestion?.observation).not.toContain("reorder level");
    expect(suggestion?.observation).toContain("out of stock");
  });

  it("still says reorder level where the owner did set one", () => {
    const found = detect(
      inputs({
        stock: [stockRow({ status: "LOW", minStockLevel: "200" })],
      }),
    );
    const suggestion = only(found).find(
      (entry) => entry.key === "STOCK_OUT_RISK",
    );
    expect(suggestion?.observation).toContain("reorder level you set");
  });
});

describe("bills the shop owes", () => {
  const owing: LedgerAgeing = {
    summary: {
      total: "180000",
      overdue: "120000",
      buckets: {},
      oldestOverdueDays: 47,
    },
    parties: [
      {
        partyId: "s1",
        name: "Metro Wholesale",
        total: "120000",
        overdue: "90000",
      },
      {
        partyId: "s2",
        name: "Kumar Traders",
        total: "60000",
        overdue: "30000",
      },
    ] as unknown as LedgerAgeing["parties"],
  };

  it("says what is past due and to how many suppliers", () => {
    // The advisor told a shop when its customers owed it money and never when
    // it owed suppliers — the payables ageing was built and simply unread.
    const found = detect(inputs({ payables: owing }));
    const suggestion = only(found).find(
      (entry) => entry.key === "OVERDUE_PAYABLES",
    );

    expect(suggestion).toBeDefined();
    expect(suggestion?.evidence.suppliers).toBe(2);
    expect(suggestion?.evidence.oldestOverdueDays).toBe(47);
    expect(suggestion?.observation).toContain("2 suppliers");
    expect(suggestion?.observation).toContain("47 days");
  });

  it("calls it recorded rather than estimated, because it is", () => {
    const found = detect(inputs({ payables: owing }));
    const suggestion = only(found).find(
      (entry) => entry.key === "OVERDUE_PAYABLES",
    );
    expect(suggestion?.impact.kind).toBe("recorded");
  });

  it("leaves a trivial balance alone", () => {
    const found = detect(
      inputs({
        payables: {
          summary: {
            total: "400",
            overdue: "400",
            buckets: {},
            oldestOverdueDays: 5,
          },
          parties: [],
        },
      }),
    );
    expect(keys(found)).not.toContain("OVERDUE_PAYABLES");
  });

  it("says nothing at all when nothing is past due", () => {
    expect(keys(detect(inputs()))).not.toContain("OVERDUE_PAYABLES");
  });
});

describe("a detector that throws", () => {
  it("takes out its own suggestion and nothing else", () => {
    // The service goes to some trouble to survive a source it cannot read.
    // Without the same care here, one detector meeting a shape it did not
    // expect would throw all of that away and return an error page instead of
    // the suggestions that were fine.
    const broken = inputs({
      payables: {
        summary: {
          total: "180000",
          overdue: "120000",
          buckets: {},
          oldestOverdueDays: 47,
        },
        // `parties` is read with .filter; a shape that is not an array is the
        // cheapest way to make exactly one detector fail.
        parties: null as unknown as LedgerAgeing["parties"],
      },
      receivables: {
        summary: {
          total: "90000",
          overdue: "90000",
          buckets: {},
          oldestOverdueDays: 12,
        },
        parties: [],
      },
    });

    const found = detect(broken);
    expect(found.failed).toContain("OVERDUE_PAYABLES");
    // The receivables suggestion is unaffected.
    expect(keys(found)).toContain("OVERDUE_RECEIVABLES");
  });
});
