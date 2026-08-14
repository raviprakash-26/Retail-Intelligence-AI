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
 * Both turn on the same fact — how much of the money moved in cash — and both
 * get it wrong in the same direction when that fact is assumed rather than
 * measured. A shop that banks everything is entitled to a ₹3 crore presumptive
 * ceiling and a ₹10 crore audit limit, and usually does not know it.
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

describe("the turnover ceiling", () => {
  it("is ₹2 crore for a business that handles cash", () => {
    const result = mix(PRESUMPTIVE_LIMIT + 1, 0, 100);
    expect(result.limitApplied).toBe(PRESUMPTIVE_LIMIT);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/2 crore ceiling/i);
  });

  it("rises to ₹3 crore where cash is within 5% of receipts", () => {
    // ₹2.5 crore of turnover, 2% of it collected in cash.
    const result = mix(25_000_000, 980_000, 20_000);
    expect(result.limitApplied).toBe(PRESUMPTIVE_LIMIT_LOW_CASH);
    expect(result.eligible).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/₹3 crore ceiling applies/i);
  });

  it("holds the line exactly at 5%", () => {
    const atFive = mix(25_000_000, 950_000, 50_000);
    const justOver = mix(25_000_000, 949_000, 51_000);
    expect(atFive.limitApplied).toBe(PRESUMPTIVE_LIMIT_LOW_CASH);
    expect(justOver.limitApplied).toBe(PRESUMPTIVE_LIMIT);
    expect(justOver.eligible).toBe(false);
  });

  it("admits a business sitting exactly on the ceiling", () => {
    const result = mix(PRESUMPTIVE_LIMIT, 0, 100);
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
