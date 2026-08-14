import { describe, expect, it } from "vitest";
import {
  computeStatutory,
  totalStatutory,
  EPF,
  ESI,
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

    expect(n(result.employeeStateInsurance)).toBeCloseTo(112.5, 4);
    expect(n(result.employerStateInsurance)).toBeCloseTo(487.5, 4);
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
