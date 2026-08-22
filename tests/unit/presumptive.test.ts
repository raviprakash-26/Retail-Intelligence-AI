import { describe, expect, it } from "vitest";
import {
  AUDIT_LIMIT,
  AUDIT_LIMIT_LOW_CASH,
  auditApplicability,
  PRESUMPTIVE_LIMIT,
  PRESUMPTIVE_LIMIT_LOW_CASH,
  presumptiveIncome,
} from "@/lib/tax/presumptive";

/**
 * Section 44AD, and the audit threshold that sits next to it.
 *
 * Both relax at 5% of cash, and it is tempting to read that as one rule. It is
 * not: 44AD measures cash receipts against *turnover*, and 44AB measures cash
 * receipts against *total receipts* and cash payments against total payments.
 * The same number, three denominators. Using 44AB's for 44AD is a defect this
 * file used to assert as the intended behaviour.
 *
 * A shop that banks everything is entitled to a ₹3 crore presumptive ceiling
 * and a ₹10 crore audit limit, and usually does not know it. Getting the
 * denominator wrong takes the first of those away from businesses that have it.
 */

const mix = (turnover: number, digital: number, cash: number) =>
  presumptiveIncome({
    turnover,
    digitalReceipts: digital,
    cashReceipts: cash,
    assessee: "INDIVIDUAL",
  });

describe("deemed income", () => {
  it("is 8% of turnover when everything came in as cash", () => {
    const result = mix(1_000_000, 0, 1_000_000);
    expect(result.incomeAtFullRate.toFixed(2)).toBe("80000.00");
    expect(result.incomeAtSplitRate.toFixed(2)).toBe("80000.00");
    expect(result.digitalSharePercent).toBe(0);
  });

  it("is 6% of the part that came through a bank", () => {
    const result = mix(1_000_000, 1_000_000, 0);
    expect(result.digitalSharePercent).toBe(100);
    expect(result.incomeAtSplitRate.toFixed(2)).toBe("60000.00");
    // The 8% figure stays visible: it is the one that holds whatever the mix.
    expect(result.incomeAtFullRate.toFixed(2)).toBe("80000.00");
  });

  it("splits proportionally on a mixed year", () => {
    // Half banked: 6% on ₹5,00,000 plus 8% on ₹5,00,000 = ₹70,000.
    const result = mix(1_000_000, 500_000, 500_000);
    expect(result.digitalSharePercent).toBe(50);
    expect(result.digitalTurnover.toFixed(2)).toBe("500000.00");
    expect(result.incomeAtSplitRate.toFixed(2)).toBe("70000.00");
  });

  it("never claims a lower figure than the split can support", () => {
    // The split rate can only ever be at or below the flat 8%.
    for (const share of [0, 10, 33, 50, 90, 100]) {
      const result = mix(2_000_000, share, 100 - share);
      expect(Number(result.incomeAtSplitRate)).toBeLessThanOrEqual(
        Number(result.incomeAtFullRate) + 0.005,
      );
    }
  });

  it("splits nothing when no money came in at all", () => {
    // Credit sales only, nothing collected yet: no basis for a split, so the
    // whole turnover sits at 8% rather than being flattered by a guess.
    const result = mix(500_000, 0, 0);
    expect(result.digitalSharePercent).toBe(0);
    expect(result.incomeAtSplitRate.toFixed(2)).toBe("40000.00");
  });

  it("adds the two halves of turnover back to the whole", () => {
    const result = mix(1_234_567, 700_000, 300_000);
    expect(
      Number(result.digitalTurnover) + Number(result.cashTurnover),
    ).toBeCloseTo(1_234_567, 2);
  });
});

describe("who may use it", () => {
  it("is open to an individual, a family and a firm", () => {
    for (const assessee of ["INDIVIDUAL", "HUF", "FIRM"] as const) {
      const result = presumptiveIncome({
        turnover: 1_000_000,
        digitalReceipts: 1_000_000,
        cashReceipts: 0,
        assessee,
      });
      expect(result.eligible).toBe(true);
    }
  });

  it("is closed to a limited liability partnership", () => {
    const result = presumptiveIncome({
      turnover: 1_000_000,
      digitalReceipts: 1_000_000,
      cashReceipts: 0,
      assessee: "LLP",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/limited liability partnership/i);
  });

  it("is closed to a company", () => {
    const result = presumptiveIncome({
      turnover: 1_000_000,
      digitalReceipts: 1_000_000,
      cashReceipts: 0,
      assessee: "COMPANY",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/company cannot/i);
  });

  it("says what still has to be confirmed rather than declaring it settled", () => {
    // Turnover and legal form are measurable; the nature of the business is
    // not, and pretending otherwise would be the misleading part.
    const result = mix(1_000_000, 1_000_000, 0);
    expect(result.reasons.join(" ")).toMatch(
      /agency, a commission business or a profession/i,
    );
  });
});

/**
 * The proviso to section 44AD(1) raises the ceiling to ₹3 crore where "the
 * amount or aggregate of the amounts received during the previous year, in
 * cash, does not exceed five per cent of the total turnover or gross receipts".
 *
 * Against turnover. Not against the money that came in — that is section 44AB's
 * denominator, tested below, and the two part company for any business with
 * debtors. Turnover is what was sold; receipts are what was collected, and a
 * year contains sales that will be paid for later and collections of sales made
 * earlier. Measuring the first rule with the second one's ratio denies the
 * section to businesses entitled to it, and the further receipts sit from
 * turnover the wider the gap.
 */
describe("the turnover ceiling", () => {
  it("is ₹2 crore for a business that handles cash", () => {
    // A rupee over the ordinary ceiling, with a fifth of the turnover taken
    // across the counter. This case used to say ₹100 of cash and no other
    // receipts at all, which made it a cash business by ratio and not by any
    // other reading — it was measuring the wrong denominator and needed a
    // business that had barely traded to do it.
    const result = mix(PRESUMPTIVE_LIMIT + 1, 16_000_000, 4_000_000);

    expect(result.cashShareOfTurnoverPercent).toBeCloseTo(20, 1);
    expect(result.limitApplied).toBe(PRESUMPTIVE_LIMIT);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/2 crore ceiling/i);
  });

  it("rises to ₹3 crore where cash is within 5% of turnover", () => {
    // ₹2.5 crore of turnover, ₹20,000 of it taken in cash.
    const result = mix(25_000_000, 980_000, 20_000);
    expect(result.limitApplied).toBe(PRESUMPTIVE_LIMIT_LOW_CASH);
    expect(result.eligible).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/₹3 crore ceiling applies/i);
  });

  it("measures the cash against turnover, not against the year's receipts", () => {
    // The case that was decided wrongly. ₹2.5 crore sold; ₹10 lakh of it
    // collected so far, ₹51,000 of that in cash. Cash is 5.1% of the money
    // that came in and 0.204% of what was sold — and it is the second figure
    // the section asks about, so the ₹3 crore ceiling applies and this
    // business may use it.
    const result = mix(25_000_000, 949_000, 51_000);

    expect(result.cashShareOfTurnoverPercent).toBeCloseTo(0.2, 2);
    expect(result.limitApplied).toBe(PRESUMPTIVE_LIMIT_LOW_CASH);
    expect(result.eligible).toBe(true);
  });

  it("still refuses the higher ceiling to a business that is genuinely cash-heavy", () => {
    // The relaxation has to keep meaning something. ₹2.5 crore of turnover
    // with ₹30 lakh taken in cash is 12% of it, whatever the receipts say.
    const result = mix(25_000_000, 3_000_000, 3_000_000);

    expect(result.cashShareOfTurnoverPercent).toBeCloseTo(12, 2);
    expect(result.limitApplied).toBe(PRESUMPTIVE_LIMIT);
    expect(result.eligible).toBe(false);
  });

  it("holds the line exactly at 5% of turnover", () => {
    // Compared as amounts rather than as a rounded percentage, so a business
    // sitting on the line is not moved across it by the second decimal place.
    const atFive = mix(25_000_000, 0, 1_250_000);
    const justOver = mix(25_000_000, 0, 1_250_001);

    expect(atFive.limitApplied).toBe(PRESUMPTIVE_LIMIT_LOW_CASH);
    expect(justOver.limitApplied).toBe(PRESUMPTIVE_LIMIT);
    expect(justOver.eligible).toBe(false);
  });

  it("says which figure it used, because the two are easily confused", () => {
    const result = mix(25_000_000, 949_000, 51_000);
    // Naming the percentage is the difference between a reader who can check
    // the answer and one who has to guess which ratio was meant.
    expect(result.reasons.join(" ")).toMatch(/0\.2% of it/);
    expect(result.reasons.join(" ")).toMatch(
      /not account payee counts as cash/i,
    );
  });

  it("admits a business sitting exactly on the ceiling", () => {
    const result = mix(PRESUMPTIVE_LIMIT, 0, 100);
    expect(result.eligible).toBe(true);
  });

  it("does not divide by a turnover of nothing", () => {
    const result = mix(0, 0, 0);
    expect(result.cashShareOfTurnoverPercent).toBe(0);
    expect(result.eligible).toBe(true);
  });
});

describe("the audit threshold", () => {
  const audit = (turnover: number, receipts: number, payments: number) =>
    auditApplicability({
      turnover,
      cashReceiptSharePercent: receipts,
      cashPaymentSharePercent: payments,
    });

  it("bites above ₹1 crore for an ordinary cash business", () => {
    expect(audit(AUDIT_LIMIT + 1, 40, 40).required).toBe(true);
    expect(audit(AUDIT_LIMIT, 40, 40).required).toBe(false);
  });

  it("rises to ₹10 crore only when both sides are nearly cashless", () => {
    expect(audit(50_000_000, 2, 2).required).toBe(false);
    expect(audit(50_000_000, 2, 2).limitApplied).toBe(AUDIT_LIMIT_LOW_CASH);

    // One side over 5% is enough to lose the relaxation.
    expect(audit(50_000_000, 2, 9).required).toBe(true);
    expect(audit(50_000_000, 9, 2).required).toBe(true);
  });

  it("explains which limit it used", () => {
    expect(audit(50_000_000, 2, 2).reason).toMatch(/₹10 crore limit applies/i);
    expect(audit(200_000_000, 2, 2).reason).toMatch(/appears to be required/i);
    expect(audit(5_000_000, 40, 40).reason).toMatch(/within the ₹1 crore/i);
  });

  it("hedges rather than declaring the matter closed", () => {
    // An audit requirement can also arise from things outside turnover, so the
    // wording says "appears to be" and not "is".
    expect(audit(200_000_000, 40, 40).reason).toContain("appears to be");
  });
});
