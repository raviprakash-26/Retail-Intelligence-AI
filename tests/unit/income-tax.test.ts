import { describe, expect, it } from "vitest";
import {
  ADVANCE_TAX_THRESHOLD,
  advanceTaxDue,
  advanceTaxSchedule,
  assessmentYearFor,
  computeIncomeTax,
  knownAssessmentYears,
  rateTableFor,
  regimeApplies,
  roundToNearestTen,
  type Assessee,
  type TaxRegime,
} from "@/lib/tax/income-tax";

/**
 * Slabs, rebate, surcharge and cess.
 *
 * Every figure here was worked out by hand from the rate table the code claims
 * to implement. A tax computation that is merely self-consistent is worthless —
 * the point of these is that they would fail if the bands were shifted, the
 * rebate silently dropped, or marginal relief quietly left out.
 */

const table = rateTableFor("2026-27");
if (!table) throw new Error("The rate table under test is missing.");

const tax = (
  totalIncome: number,
  options: { assessee?: Assessee; regime?: TaxRegime } = {},
) =>
  computeIncomeTax({
    totalIncome,
    table,
    assessee: options.assessee ?? "INDIVIDUAL",
    regime: options.regime ?? "NEW",
  });

describe("the rate table", () => {
  it("refuses to substitute another year's law", () => {
    // Silently applying this year's rates to last year's income produces a
    // computation that looks entirely correct and is wrong.
    expect(rateTableFor("2019-20")).toBeNull();
    expect(knownAssessmentYears()).toContain("2026-27");
  });

  it("assesses a financial year in the year after it", () => {
    expect(assessmentYearFor(2025)).toBe("2026-27");
    expect(assessmentYearFor(2026)).toBe("2027-28");
    expect(assessmentYearFor(2098)).toBe("2099-00");
  });

  it("marks a carried-forward table as provisional", () => {
    // The current year's rates are last year's until the Finance Act is
    // entered. Computing on them is useful; doing it silently is not.
    const current = rateTableFor("2027-28");
    expect(current?.provisional).toBe(true);
    expect(current?.basis).toMatch(/carried forward/i);
    expect(table.provisional).toBe(false);

    // And the flag travels with every figure computed from it.
    expect(
      computeIncomeTax({
        totalIncome: 1_600_000,
        table: current!,
        assessee: "INDIVIDUAL",
        regime: "NEW",
      }).provisional,
    ).toBe(true);
  });

  it("offers the regime choice only where it exists", () => {
    expect(regimeApplies("INDIVIDUAL")).toBe(true);
    expect(regimeApplies("HUF")).toBe(true);
    expect(regimeApplies("FIRM")).toBe(false);
    expect(regimeApplies("COMPANY")).toBe(false);
  });
});

describe("the new regime slabs", () => {
  it("taxes nothing inside the basic exemption", () => {
    expect(tax(400_000).totalTax.toFixed(2)).toBe("0.00");
  });

  it("charges 5% on the second band", () => {
    // ₹6,00,000: nothing on the first ₹4,00,000, 5% on ₹2,00,000 = ₹10,000,
    // then the whole of it wiped out by the section 87A rebate.
    const result = tax(600_000);
    expect(result.taxOnIncome.toFixed(2)).toBe("10000.00");
    expect(result.rebate.toFixed(2)).toBe("10000.00");
    expect(result.totalTax.toFixed(2)).toBe("0.00");
  });

  it("pays nothing at all up to twelve lakh", () => {
    // 5% of 4L + 10% of 4L = 20,000 + 40,000 = 60,000, exactly the rebate cap.
    const result = tax(1_200_000);
    expect(result.taxOnIncome.toFixed(2)).toBe("60000.00");
    expect(result.rebate.toFixed(2)).toBe("60000.00");
    expect(result.totalTax.toFixed(2)).toBe("0.00");
  });

  it("charges tax on a middling income, with cess", () => {
    // ₹16,00,000: 5% of 4L = 20,000; 10% of 4L = 40,000; 15% of 4L = 60,000.
    // Tax 1,20,000 and no rebate; cess 4% = 4,800.
    const result = tax(1_600_000);
    expect(result.taxOnIncome.toFixed(2)).toBe("120000.00");
    expect(result.rebate.toFixed(2)).toBe("0.00");
    expect(result.cess.toFixed(2)).toBe("4800.00");
    expect(result.totalTax.toFixed(2)).toBe("124800.00");
  });

  it("charges the top rate above twenty-four lakh", () => {
    // 20,000 + 40,000 + 60,000 + 80,000 + 1,00,000 = 3,00,000 to ₹24,00,000,
    // then 30% of the ₹6,00,000 above it.
    const result = tax(3_000_000);
    expect(result.taxOnIncome.toFixed(2)).toBe("480000.00");
    expect(result.totalTax.toFixed(2)).toBe("499200.00");
  });

  it("shows the working, band by band", () => {
    const result = tax(1_000_000);
    expect(result.bands.map((band) => band.ratePercent)).toEqual([0, 5, 10]);
    expect(result.bands.map((band) => band.income.toFixed(0))).toEqual([
      "400000",
      "400000",
      "200000",
    ]);
    // The bands must account for every rupee of income, or the total is a
    // number nobody can check.
    const covered = result.bands.reduce(
      (sum, band) => sum + Number(band.income),
      0,
    );
    expect(covered).toBe(1_000_000);
  });
});

describe("the section 87A rebate", () => {
  it("does not fall off a cliff just above the threshold", () => {
    // At ₹12,10,000 the tax before relief is ₹61,500. Without marginal relief
    // earning ₹10,000 more would cost ₹61,500 — so tax is limited to the
    // ₹10,000 of income above the threshold.
    const result = tax(1_210_000);
    expect(result.taxOnIncome.toFixed(2)).toBe("61500.00");
    expect(result.taxAfterRebate.toFixed(2)).toBe("10000.00");
    expect(result.totalTax.toFixed(2)).toBe("10400.00");
  });

  it("stops relieving once the tax is less than the extra income", () => {
    // By ₹13,00,000 the tax (₹75,000) is below the ₹1,00,000 of income above
    // the threshold, so relief no longer bites.
    const result = tax(1_300_000);
    expect(result.rebate.toFixed(2)).toBe("0.00");
    expect(result.taxAfterRebate.toFixed(2)).toBe("75000.00");
  });

  it("caps the tax at the income above the threshold, but not the cess on it", () => {
    // The relief limits income-tax to the excess income. Cess is then charged
    // on that capped figure, so ₹10,000 of extra income can attract ₹10,400 of
    // tax. That is the law working as written, not an error here — and it is
    // why the guarantee below is stated before cess rather than after it.
    for (let income = 1_200_000; income <= 1_290_000; income += 5_000) {
      const result = tax(income);
      const excess = income - 1_200_000;
      expect(Number(result.taxAfterRebate)).toBeLessThanOrEqual(excess + 0.005);
      expect(Number(result.totalTax)).toBeLessThanOrEqual(
        excess * 1.04 + 0.005,
      );
    }
  });

  it("is never worse to earn more, before cess", () => {
    // Inside the relief band the net is flat rather than rising: every rupee
    // above ₹12,00,000 is taken as tax until ordinary rates are cheaper than
    // that. Flat is the point — it is a cliff that has been filed down, not
    // removed.
    let previous = -1;
    for (let income = 1_190_000; income <= 1_290_000; income += 5_000) {
      const net = income - Number(tax(income).taxAfterRebate);
      expect(net).toBeGreaterThanOrEqual(previous);
      previous = net;
    }
    expect(previous).toBeGreaterThan(1_200_000);
  });

  it("applies the old regime's smaller rebate at its own threshold", () => {
    const result = tax(500_000, { regime: "OLD" });
    // 5% of the ₹2,50,000 above the exemption is ₹12,500, exactly the cap.
    expect(result.taxOnIncome.toFixed(2)).toBe("12500.00");
    expect(result.totalTax.toFixed(2)).toBe("0.00");
  });

  it("belongs to individuals, not to a Hindu Undivided Family", () => {
    // Section 87A is available to a resident individual only.
    const individual = tax(600_000, { assessee: "INDIVIDUAL" });
    const huf = tax(600_000, { assessee: "HUF" });
    expect(individual.totalTax.toFixed(2)).toBe("0.00");
    expect(huf.totalTax.toFixed(2)).toBe("10400.00");
  });
});

describe("the old regime", () => {
  it("uses its own bands", () => {
    // ₹10,00,000: 5% of 2.5L = 12,500; 20% of 5L = 1,00,000. Tax 1,12,500.
    const result = tax(1_000_000, { regime: "OLD" });
    expect(result.taxOnIncome.toFixed(2)).toBe("112500.00");
    expect(result.totalTax.toFixed(2)).toBe("117000.00");
  });

  it("gives a senior citizen a larger exemption", () => {
    const ordinary = computeIncomeTax({
      totalIncome: 800_000,
      table,
      assessee: "INDIVIDUAL",
      regime: "OLD",
      ageBand: "BELOW_60",
    });
    const senior = computeIncomeTax({
      totalIncome: 800_000,
      table,
      assessee: "INDIVIDUAL",
      regime: "OLD",
      ageBand: "SENIOR",
    });
    // The extra ₹50,000 of exemption saves 5% of it.
    expect(
      Number(ordinary.taxOnIncome) - Number(senior.taxOnIncome),
    ).toBeCloseTo(2_500, 2);
  });

  it("ignores age under the new regime", () => {
    const young = computeIncomeTax({
      totalIncome: 1_500_000,
      table,
      assessee: "INDIVIDUAL",
      regime: "NEW",
      ageBand: "BELOW_60",
    });
    const old = computeIncomeTax({
      totalIncome: 1_500_000,
      table,
      assessee: "INDIVIDUAL",
      regime: "NEW",
      ageBand: "SUPER_SENIOR",
    });
    expect(young.totalTax.toFixed(2)).toBe(old.totalTax.toFixed(2));
  });
});

describe("surcharge", () => {
  it("is not charged below the first threshold", () => {
    const result = tax(5_000_000);
    expect(result.surchargeRatePercent).toBe(0);
    expect(result.surcharge.toFixed(2)).toBe("0.00");
  });

  it("is charged at 10% above fifty lakh", () => {
    const result = tax(6_000_000);
    expect(result.surchargeRatePercent).toBe(10);
    expect(Number(result.surcharge)).toBeGreaterThan(0);
  });

  it("never makes crossing a threshold cost more than it earned", () => {
    // Income just above ₹50,00,000 must not attract more extra tax than the
    // extra income — that is what marginal relief is for, and it is the single
    // most commonly missed step in a hand-built computation. As with the
    // rebate, the relief caps tax and surcharge, and cess then rides on top.
    const below = tax(5_000_000);
    const above = tax(5_010_000);
    expect(Number(above.marginalRelief)).toBeGreaterThan(0);
    expect(
      Number(above.taxAfterRebate) +
        Number(above.surcharge) -
        Number(above.marginalRelief) -
        Number(below.taxAfterRebate),
    ).toBeLessThanOrEqual(10_000 + 0.005);
    expect(Number(above.totalTax) - Number(below.totalTax)).toBeLessThanOrEqual(
      10_000 * 1.04 + 0.005,
    );
  });

  it("caps the new regime at 25% where the old one goes to 37%", () => {
    const newRegime = tax(60_000_000, { regime: "NEW" });
    const oldRegime = tax(60_000_000, { regime: "OLD" });
    expect(newRegime.surchargeRatePercent).toBe(25);
    expect(oldRegime.surchargeRatePercent).toBe(37);
  });
});

describe("assessees that are not individuals", () => {
  it("taxes a partnership firm at a flat 30%", () => {
    const result = tax(1_000_000, { assessee: "FIRM" });
    expect(result.bands).toHaveLength(0);
    expect(result.flatRatePercent).toBe(30);
    expect(result.taxOnIncome.toFixed(2)).toBe("300000.00");
    expect(result.totalTax.toFixed(2)).toBe("312000.00");
  });

  it("gives a firm no basic exemption and no rebate", () => {
    const result = tax(300_000, { assessee: "FIRM" });
    expect(result.rebate.toFixed(2)).toBe("0.00");
    expect(result.taxOnIncome.toFixed(2)).toBe("90000.00");
  });

  it("taxes a company at its own rate", () => {
    const result = tax(1_000_000, { assessee: "COMPANY" });
    expect(result.flatRatePercent).toBe(25);
    expect(result.taxOnIncome.toFixed(2)).toBe("250000.00");
  });

  it("ignores a regime choice that does not apply to it", () => {
    const asNew = tax(1_000_000, { assessee: "FIRM", regime: "NEW" });
    const asOld = tax(1_000_000, { assessee: "FIRM", regime: "OLD" });
    expect(asNew.totalTax.toFixed(2)).toBe(asOld.totalTax.toFixed(2));
  });
});

describe("edges", () => {
  it("treats a loss as no tax rather than as a refund", () => {
    const result = tax(-500_000);
    expect(result.totalIncome.toFixed(2)).toBe("0.00");
    expect(result.totalTax.toFixed(2)).toBe("0.00");
    expect(result.effectiveRatePercent).toBeNull();
  });

  it("rounds the liability to the nearest ten rupees", () => {
    // Section 288B.
    expect(roundToNearestTen(10_004).toFixed(2)).toBe("10000.00");
    expect(roundToNearestTen(10_005).toFixed(2)).toBe("10010.00");
    expect(roundToNearestTen(10_006).toFixed(2)).toBe("10010.00");
  });

  it("reports an effective rate that matches the tax", () => {
    const result = tax(2_000_000);
    const implied =
      (Number(result.totalTax) / Number(result.totalIncome)) * 100;
    expect(result.effectiveRatePercent).toBeCloseTo(implied, 2);
  });
});

describe("advance tax", () => {
  it("is only due once the liability reaches ten thousand rupees", () => {
    expect(advanceTaxDue(ADVANCE_TAX_THRESHOLD - 1)).toBe(false);
    expect(advanceTaxDue(ADVANCE_TAX_THRESHOLD)).toBe(true);
  });

  it("falls due in four instalments on the prescribed dates", () => {
    const schedule = advanceTaxSchedule({
      totalTax: 100_000,
      financialYearStart: 2025,
      asOf: new Date("2025-07-01T00:00:00.000Z"),
    });

    expect(schedule.map((row) => row.dueDate)).toEqual([
      "2025-06-15",
      "2025-09-15",
      "2025-12-15",
      "2026-03-15",
    ]);
    expect(schedule.map((row) => row.cumulativePercent)).toEqual([
      15, 45, 75, 100,
    ]);
    expect(schedule.map((row) => row.instalmentAmount.toFixed(0))).toEqual([
      "15000",
      "30000",
      "30000",
      "25000",
    ]);
    // Only the June date has passed on 1 July.
    expect(schedule.map((row) => row.elapsed)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("adds up to the whole liability", () => {
    const schedule = advanceTaxSchedule({
      totalTax: 87_654,
      financialYearStart: 2025,
    });
    const total = schedule.reduce(
      (sum, row) => sum + Number(row.instalmentAmount),
      0,
    );
    expect(total).toBeCloseTo(87_654, 2);
  });

  it("has a single instalment under the presumptive scheme", () => {
    const schedule = advanceTaxSchedule({
      totalTax: 50_000,
      financialYearStart: 2025,
      presumptive: true,
    });
    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.dueDate).toBe("2026-03-15");
    expect(schedule[0]?.cumulativeAmount.toFixed(0)).toBe("50000");
  });
});
