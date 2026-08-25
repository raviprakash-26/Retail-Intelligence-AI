import { describe, expect, it } from "vitest";
import {
  computeStatutory,
  totalStatutory,
  EPF,
  ESI,
  KARNATAKA_PROFESSIONAL_TAX,
  NO_STATUTORY_DEDUCTIONS,
  type PayrollPolicy,
} from "@/lib/payroll/statutory";

/**
 * Statutory deductions.
 *
 * Payroll is arithmetic somebody's rent depends on, so the tests are figures
 * worked by hand rather than the code's own output read back. Each one names
 * the rule it is checking.
 */

const FULL: PayrollPolicy = {
  providentFund: true,
  employeeStateInsurance: true,
  professionalTaxMonthly: 200,
};

const n = (value: { toString(): string }) => Number(value.toString());

describe("provident fund", () => {
  it("takes 12% of basic from the employee and 12% again from the employer", () => {
    const result = computeStatutory(
      { basicSalary: 10_000, allowances: 0 },
      { ...FULL, employeeStateInsurance: false, professionalTaxMonthly: null },
    );

    expect(n(result.employeeProvidentFund)).toBeCloseTo(1200, 4);
    expect(n(result.employerProvidentFund)).toBeCloseTo(1200, 4);
    // The employer's share is a cost, not a deduction: it does not come out of
    // the employee's pay.
    expect(n(result.net)).toBeCloseTo(8800, 4);
    expect(n(result.costToCompany)).toBeCloseTo(11_200, 4);
  });

  it("stops at the ₹15,000 wage ceiling", () => {
    const result = computeStatutory(
      { basicSalary: 40_000, allowances: 0 },
      { ...FULL, employeeStateInsurance: false, professionalTaxMonthly: null },
    );

    // 12% of 15,000, not of 40,000.
    expect(n(result.employeeProvidentFund)).toBeCloseTo(1800, 4);
    expect(EPF.wageCeiling).toBe(15_000);
  });

  it("is computed on basic alone, not on allowances", () => {
    const onBasic = computeStatutory(
      { basicSalary: 10_000, allowances: 0 },
      { ...FULL, employeeStateInsurance: false, professionalTaxMonthly: null },
    );
    const withAllowances = computeStatutory(
      { basicSalary: 10_000, allowances: 5_000 },
      { ...FULL, employeeStateInsurance: false, professionalTaxMonthly: null },
    );

    expect(n(withAllowances.employeeProvidentFund)).toBeCloseTo(
      n(onBasic.employeeProvidentFund),
      4,
    );
  });

  it("is nil when the establishment is not registered", () => {
    const result = computeStatutory(
      { basicSalary: 10_000, allowances: 0 },
      NO_STATUTORY_DEDUCTIONS,
    );
    expect(n(result.employeeProvidentFund)).toBe(0);
    expect(n(result.employerProvidentFund)).toBe(0);
    expect(n(result.net)).toBeCloseTo(10_000, 4);
  });
});

describe("employee state insurance", () => {
  it("takes 0.75% from the employee and 3.25% from the employer, on gross", () => {
    const result = computeStatutory(
      { basicSalary: 10_000, allowances: 5_000 },
      { ...FULL, providentFund: false, professionalTaxMonthly: null },
    );

    // 0.75% and 3.25% of ₹15,000 are ₹112.50 and ₹487.50, and Regulation 40
    // takes each to the next higher rupee.
    expect(n(result.employeeStateInsurance)).toBe(113);
    expect(n(result.employerStateInsurance)).toBe(488);
  });

  it("drops out entirely above the wage limit, rather than capping", () => {
    // This is the rule people get wrong: an employee earning ₹21,001 is
    // outside the scheme, not contributing on ₹21,000.
    const inside = computeStatutory(
      { basicSalary: 21_000, allowances: 0 },
      { ...FULL, providentFund: false, professionalTaxMonthly: null },
    );
    const outside = computeStatutory(
      { basicSalary: 21_001, allowances: 0 },
      { ...FULL, providentFund: false, professionalTaxMonthly: null },
    );

    expect(n(inside.employeeStateInsurance)).toBeGreaterThan(0);
    expect(n(outside.employeeStateInsurance)).toBe(0);
    expect(n(outside.employerStateInsurance)).toBe(0);
    expect(ESI.wageLimit).toBe(21_000);
  });
});

/**
 * Whole rupees, because that is the only thing either scheme accepts.
 *
 * Both returns are filed in rupees — the ECR takes no paise, and neither does
 * the ESI challan. A contribution carrying a fraction is not a contribution
 * anybody can remit, and it goes to the payable account all the same, so the
 * liability drifts from the payment by paise a month and the account never
 * clears.
 *
 * The two schemes do not round the same way, and that is the point of doing
 * each explicitly: ESI Regulation 40 takes every contribution to the *next
 * higher* rupee, so ₹113.25 is ₹114 and ₹112.50 is ₹113. EPF rounds to the
 * *nearest*, so ₹1,481.40 stays ₹1,481. Rounding both the same way would be
 * right for one scheme and wrong for the other in the same payslip.
 */
describe("contributions are whole rupees", () => {
  const esiOnly: PayrollPolicy = {
    ...FULL,
    providentFund: false,
    professionalTaxMonthly: null,
  };
  const pfOnly: PayrollPolicy = {
    ...FULL,
    employeeStateInsurance: false,
    professionalTaxMonthly: null,
  };

  it("takes ESI up to the next rupee, not to the nearest", () => {
    // 0.75% of ₹15,100 is ₹113.25. Rounding to the nearest would give ₹113;
    // Regulation 40 says ₹114.
    const employee = computeStatutory(
      { basicSalary: 15_100, allowances: 0 },
      esiOnly,
    );
    expect(n(employee.employeeStateInsurance)).toBe(114);

    // 3.25% of ₹10,100 is ₹328.25 — the same quarter-rupee, on the other share.
    const employer = computeStatutory(
      { basicSalary: 10_100, allowances: 0 },
      esiOnly,
    );
    expect(n(employer.employerStateInsurance)).toBe(329);
  });

  it("leaves an ESI contribution that is already whole alone", () => {
    // 0.75% of ₹20,000 is exactly ₹150. Rounding up is about the fraction, not
    // about always adding a rupee.
    const result = computeStatutory(
      { basicSalary: 20_000, allowances: 0 },
      esiOnly,
    );
    expect(n(result.employeeStateInsurance)).toBe(150);
    expect(n(result.employerStateInsurance)).toBe(650);
  });

  it("takes EPF to the nearest rupee, in both directions", () => {
    // 12% of ₹12,345 is ₹1,481.40 — down to ₹1,481, where rounding up would
    // have said ₹1,482.
    const down = computeStatutory(
      { basicSalary: 12_345, allowances: 0 },
      pfOnly,
    );
    expect(n(down.employeeProvidentFund)).toBe(1481);
    expect(n(down.employerProvidentFund)).toBe(1481);

    // 12% of ₹12,346 is ₹1,481.52 — up to ₹1,482, where truncating would have
    // said ₹1,481.
    const up = computeStatutory({ basicSalary: 12_346, allowances: 0 }, pfOnly);
    expect(n(up.employeeProvidentFund)).toBe(1482);
    expect(n(up.employerProvidentFund)).toBe(1482);
  });

  it("adds a run up to whole rupees, so the payable can be settled", () => {
    // Three employees whose contributions each carry a fraction. What is
    // posted to the PF and ESI liabilities has to be payable to the rupee,
    // otherwise the account keeps a residue no remittance can ever clear.
    const run = [12_345, 12_346, 15_100].map((basicSalary) =>
      computeStatutory({ basicSalary, allowances: 0 }, FULL),
    );
    const totals = totalStatutory(run);

    for (const figure of [
      totals.employeeProvidentFund,
      totals.employerProvidentFund,
      totals.employeeStateInsurance,
      totals.employerStateInsurance,
    ]) {
      expect(n(figure) % 1).toBe(0);
    }
  });
});

describe("professional tax", () => {
  it("is a flat monthly figure above the threshold, not a rate", () => {
    const result = computeStatutory(
      { basicSalary: 30_000, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: 200,
      },
    );
    expect(n(result.professionalTax)).toBe(200);
  });

  it("is nil below the threshold", () => {
    const result = computeStatutory(
      { basicSalary: 20_000, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: 200,
      },
    );
    expect(n(result.professionalTax)).toBe(0);
  });

  /**
   * Exactly on the threshold.
   *
   * Karnataka levies ₹200 where the monthly wage is "not less than ₹25,000",
   * so a salary of exactly ₹25,000 is liable — and ₹25,000 is the roundest
   * number a small shop pays anybody. The comparison here was strictly
   * greater, which is the one wage in the schedule it gets wrong, and the two
   * cases either side of it never asked: they were ₹30,000 and ₹20,000.
   *
   * Under-deducting professional tax does not leave the employee better off.
   * The employer is liable for what it failed to withhold.
   */
  it("is levied on a wage exactly on the threshold", () => {
    const result = computeStatutory(
      { basicSalary: KARNATAKA_PROFESSIONAL_TAX.threshold, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: 200,
      },
    );
    expect(n(result.professionalTax)).toBe(200);
  });

  it("is nil one rupee below it", () => {
    // The other side of the same line, so the boundary is pinned rather than
    // moved.
    const result = computeStatutory(
      { basicSalary: KARNATAKA_PROFESSIONAL_TAX.threshold - 1, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: 200,
      },
    );
    expect(n(result.professionalTax)).toBe(0);
  });

  it("is nil when the business has not set one", () => {
    // Levied by the state and different in each. A plausible wrong default is
    // worse than an obviously absent one.
    const result = computeStatutory(
      { basicSalary: 50_000, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: null,
      },
    );
    expect(n(result.professionalTax)).toBe(0);
  });

  /**
   * The threshold belongs to the state as much as the amount does.
   *
   * It was fixed at Karnataka's while the amount was settable, so a business
   * in a state levying from ₹7,500 could say what it withheld but not from
   * what wage, and everybody under ₹25,000 had nothing withheld. The business
   * had said it was liable and the software quietly decided it was not.
   */
  it("is levied from the wage the business set, not Bengaluru's", () => {
    const result = computeStatutory(
      { basicSalary: 20_000, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: 200,
        professionalTaxThreshold: 7_500,
      },
    );
    expect(n(result.professionalTax)).toBe(200);
  });

  it("is still nil below the wage the business set", () => {
    // The threshold has to work in both directions, or it is just an on switch.
    const result = computeStatutory(
      { basicSalary: 5_000, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: 200,
        professionalTaxThreshold: 7_500,
      },
    );
    expect(n(result.professionalTax)).toBe(0);
  });

  it("keeps Karnataka's threshold for a business that set only the amount", () => {
    // Every business configured before the threshold was settable is in this
    // state, and none of their payrolls may move by a rupee.
    const below = computeStatutory(
      { basicSalary: 20_000, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: 200,
        professionalTaxThreshold: null,
      },
    );
    const above = computeStatutory(
      { basicSalary: 30_000, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: 200,
        professionalTaxThreshold: null,
      },
    );
    expect(n(below.professionalTax)).toBe(0);
    expect(n(above.professionalTax)).toBe(200);
  });

  /**
   * This case used to assert the opposite, and gave a reason: *"Above" means
   * above. Karnataka's own slab starts over ₹25,000.*
   *
   * The schedule says otherwise. As amended with effect from 1 April 2023 it
   * levies ₹200 where the monthly salary or wage is "not less than twenty-five
   * thousand rupees" — inclusive, so ₹25,000 exactly is liable. The reason
   * given was a statement about the law rather than about the code, and it was
   * the wrong way round.
   *
   * The threshold a business sets means the same thing: the first wage that is
   * liable. A single number cannot say whether a state's own schedule reads
   * "not less than" or "above", and the schedules are written the first way.
   */
  it("levies on a wage exactly at the threshold a business set", () => {
    const result = computeStatutory(
      { basicSalary: 7_500, allowances: 0 },
      {
        providentFund: false,
        employeeStateInsurance: false,
        professionalTaxMonthly: 200,
        professionalTaxThreshold: 7_500,
      },
    );
    expect(n(result.professionalTax)).toBe(200);
  });
});

describe("tax deducted at source", () => {
  it("is whatever was entered, and nil when nothing was", () => {
    // The platform does not compute TDS. It depends on projected annual
    // income, the elected regime and the employee's declarations, none of
    // which this can see.
    const entered = computeStatutory(
      { basicSalary: 50_000, allowances: 0, taxDeductedAtSource: 4_000 },
      NO_STATUTORY_DEDUCTIONS,
    );
    expect(n(entered.taxDeductedAtSource)).toBe(4_000);
    expect(n(entered.net)).toBeCloseTo(46_000, 4);

    const none = computeStatutory(
      { basicSalary: 50_000, allowances: 0 },
      NO_STATUTORY_DEDUCTIONS,
    );
    expect(n(none.taxDeductedAtSource)).toBe(0);
  });
});

describe("a payslip adds up", () => {
  it("nets gross less every deduction, and nothing else", () => {
    const result = computeStatutory(
      { basicSalary: 12_000, allowances: 8_000, taxDeductedAtSource: 500 },
      FULL,
    );

    const deductions =
      n(result.employeeProvidentFund) +
      n(result.employeeStateInsurance) +
      n(result.professionalTax) +
      n(result.taxDeductedAtSource);

    expect(n(result.totalDeductions)).toBeCloseTo(deductions, 4);
    expect(n(result.net)).toBeCloseTo(n(result.gross) - deductions, 4);
    // Cost to company is gross plus what the employer adds, never net.
    expect(n(result.costToCompany)).toBeCloseTo(
      n(result.gross) + n(result.employerContributions),
      4,
    );
  });

  it("is the same figure every time it is computed", () => {
    // A run has to be reproducible, or a correction cannot be explained.
    const input = { basicSalary: 17_500, allowances: 3_250 };
    const first = computeStatutory(input, FULL);
    const second = computeStatutory(input, FULL);
    expect(n(first.net)).toBe(n(second.net));
  });
});

describe("a run adds up", () => {
  it("totals every payslip component by component", () => {
    const payslips = [
      computeStatutory({ basicSalary: 10_000, allowances: 2_000 }, FULL),
      computeStatutory({ basicSalary: 25_000, allowances: 5_000 }, FULL),
      computeStatutory(
        { basicSalary: 8_000, allowances: 1_000, taxDeductedAtSource: 250 },
        FULL,
      ),
    ];
    const totals = totalStatutory(payslips);

    const sum = (
      pick: (p: (typeof payslips)[number]) => { toString(): string },
    ) => payslips.reduce((running, slip) => running + n(pick(slip)), 0);

    expect(n(totals.gross)).toBeCloseTo(
      sum((p) => p.gross),
      4,
    );
    expect(n(totals.net)).toBeCloseTo(
      sum((p) => p.net),
      4,
    );
    expect(n(totals.totalDeductions)).toBeCloseTo(
      sum((p) => p.totalDeductions),
      4,
    );
    expect(n(totals.employerContributions)).toBeCloseTo(
      sum((p) => p.employerContributions),
      4,
    );
    // And the whole run still nets.
    expect(n(totals.net)).toBeCloseTo(
      n(totals.gross) - n(totals.totalDeductions),
      4,
    );
  });

  it("totals an empty run to nothing rather than failing", () => {
    const totals = totalStatutory([]);
    expect(n(totals.gross)).toBe(0);
    expect(n(totals.net)).toBe(0);
  });
});
