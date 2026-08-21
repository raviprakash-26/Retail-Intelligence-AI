import { add, money, multiply, subtract, type Decimal } from "@/lib/money";

/**
 * Statutory deductions on Indian salary.
 *
 * Three of the four are arithmetic and are computed here. The fourth — TDS on
 * salary — is not, and that distinction is the most important thing in this
 * file.
 *
 * EPF, ESI and professional tax are functions of the month's wages and a rate
 * the state or the scheme fixes. Given the pay and the applicable flags, there
 * is one right answer and it can be checked.
 *
 * TDS on salary is not that. It depends on the employee's projected income for
 * the whole year, which regime they elected, what they declared in the way of
 * investments, rent and a home loan, what a previous employer already deducted,
 * and what the employer decides to accept as proof. A number produced without
 * those inputs would look like a tax computation and be a guess, and a wrong
 * one lands on the employee. So this module **does not compute TDS**: the
 * figure is entered by whoever runs the payroll, and the product says so
 * wherever it appears.
 *
 * Whether a business is covered by EPF or ESI at all is a fact about the
 * establishment — headcount, registration, the date it crossed the threshold —
 * and not something this can infer. Both default to off and are switched on by
 * the business.
 */

/** Statutory rates and ceilings, named so a change is one edit in one place. */
export const EPF = {
  /** Employee's share of the provident fund. */
  employeeRate: 12,
  /**
   * The employer matches 12%, of which 8.33% is diverted to the pension
   * scheme. Both halves are the employer's cost and are remitted together, so
   * the split does not change the accounting and is not modelled.
   */
  employerRate: 12,
  /**
   * Contribution is mandatory only on the first ₹15,000 of monthly wages. An
   * employer may contribute on more, which is why this is a ceiling on the
   * statutory minimum rather than a cap on what can be posted.
   */
  wageCeiling: 15_000,
} as const;

export const ESI = {
  employeeRate: 0.75,
  employerRate: 3.25,
  /** Above this monthly gross an employee is out of the scheme entirely. */
  wageLimit: 21_000,
} as const;

/**
 * Professional tax, which is levied by the state and differs in every one.
 *
 * Karnataka's slab is the default because the product's own demo shop is in
 * Bengaluru, and a wrong default that looks plausible is worse than an obvious
 * one. A business elsewhere sets its own figures; the slab is not guessed from
 * the address.
 *
 * Both halves of a slab are settable, and for a while only one of them was. The
 * monthly amount could be set and the threshold could not, so a shop in a state
 * that levies from ₹7,500 would say "we levy ₹200 a month", and this would
 * silently apply Karnataka's ₹25,000 and withhold nothing from anybody earning
 * less than that. The business had said it was liable and the software quietly
 * decided it was not — which is the plausible wrong default the paragraph above
 * exists to refuse, arrived at from the other direction.
 */
export const KARNATAKA_PROFESSIONAL_TAX = {
  threshold: 25_000,
  monthly: 200,
} as const;

export type PayrollPolicy = {
  /** The establishment is registered under the EPF scheme. */
  providentFund: boolean;
  /** The establishment is registered under ESI. */
  employeeStateInsurance: boolean;
  /**
   * Monthly professional tax, or null where the state levies none or the
   * business has not said. Never inferred from the address.
   */
  professionalTaxMonthly: number | null;
  /**
   * The monthly wage above which that figure is levied.
   *
   * Null falls back to Karnataka's, which keeps every business that set a
   * monthly figure before this existed exactly where it was. A business in
   * another state sets its own rather than inheriting Bengaluru's.
   */
  professionalTaxThreshold?: number | null;
};

export const NO_STATUTORY_DEDUCTIONS: PayrollPolicy = {
  providentFund: false,
  employeeStateInsurance: false,
  professionalTaxMonthly: null,
  professionalTaxThreshold: null,
};

export type EarningsInput = {
  basicSalary: Decimal | string | number;
  allowances: Decimal | string | number;
  /** Entered, never computed. See the note at the top of this file. */
  taxDeductedAtSource?: Decimal | string | number;
};

export type StatutoryResult = {
  basicSalary: Decimal;
  allowances: Decimal;
  /** Basic plus allowances. */
  gross: Decimal;
  /** Withheld from the employee. */
  employeeProvidentFund: Decimal;
  employeeStateInsurance: Decimal;
  professionalTax: Decimal;
  taxDeductedAtSource: Decimal;
  /** Everything withheld, which is what leaves the employee's pay. */
  totalDeductions: Decimal;
  /** Gross less deductions: what the employee is actually paid. */
  net: Decimal;
  /** The employer's own contributions — a cost, not a deduction. */
  employerProvidentFund: Decimal;
  employerStateInsurance: Decimal;
  employerContributions: Decimal;
  /** Gross plus the employer's contributions: what the employee truly costs. */
  costToCompany: Decimal;
};

const percent = (base: Decimal, rate: number): Decimal =>
  multiply(base, rate / 100);

/** The lesser of the wage and the scheme's ceiling. */
function ceilingApplied(wage: Decimal, ceiling: number): Decimal {
  return wage.greaterThan(ceiling) ? money(ceiling) : wage;
}

/**
 * One employee's pay for one month.
 *
 * Every figure is derived from the inputs, so the same employee and the same
 * policy always produce the same payslip — which is what makes a run
 * reproducible and a correction explicable.
 */
export function computeStatutory(
  input: EarningsInput,
  policy: PayrollPolicy,
): StatutoryResult {
  const basicSalary = money(input.basicSalary);
  const allowances = money(input.allowances);
  const gross = add(basicSalary, allowances);
  const taxDeductedAtSource = money(input.taxDeductedAtSource ?? 0);

  // PF is on basic wages, subject to the statutory ceiling.
  const pfWage = policy.providentFund
    ? ceilingApplied(basicSalary, EPF.wageCeiling)
    : money(0);
  const employeeProvidentFund = percent(pfWage, EPF.employeeRate);
  const employerProvidentFund = percent(pfWage, EPF.employerRate);

  // ESI is on gross, and is all-or-nothing: an employee earning above the
  // limit is outside the scheme rather than contributing on a capped wage.
  const inEsi =
    policy.employeeStateInsurance && !gross.greaterThan(ESI.wageLimit);
  const employeeStateInsurance = inEsi
    ? percent(gross, ESI.employeeRate)
    : money(0);
  const employerStateInsurance = inEsi
    ? percent(gross, ESI.employerRate)
    : money(0);

  // Professional tax is a flat monthly figure above a threshold, not a rate.
  // The threshold is the business's own where it has set one; Karnataka's only
  // where it has not.
  const professionalTaxThreshold =
    policy.professionalTaxThreshold ?? KARNATAKA_PROFESSIONAL_TAX.threshold;
  const professionalTax =
    policy.professionalTaxMonthly !== null &&
    gross.greaterThan(professionalTaxThreshold)
      ? money(policy.professionalTaxMonthly)
      : money(0);

  const totalDeductions = add(
    employeeProvidentFund,
    employeeStateInsurance,
    professionalTax,
    taxDeductedAtSource,
  );

  const employerContributions = add(
    employerProvidentFund,
    employerStateInsurance,
  );

  return {
    basicSalary,
    allowances,
    gross,
    employeeProvidentFund,
    employeeStateInsurance,
    professionalTax,
    taxDeductedAtSource,
    totalDeductions,
    net: subtract(gross, totalDeductions),
    employerProvidentFund,
    employerStateInsurance,
    employerContributions,
    costToCompany: add(gross, employerContributions),
  };
}

/** Adds a run's payslips up, so the entry and the document agree by construction. */
export function totalStatutory(
  results: readonly StatutoryResult[],
): StatutoryResult {
  const zero = money(0);
  const sum = (pick: (result: StatutoryResult) => Decimal): Decimal =>
    results.reduce((running, result) => add(running, pick(result)), zero);

  return {
    basicSalary: sum((result) => result.basicSalary),
    allowances: sum((result) => result.allowances),
    gross: sum((result) => result.gross),
    employeeProvidentFund: sum((result) => result.employeeProvidentFund),
    employeeStateInsurance: sum((result) => result.employeeStateInsurance),
    professionalTax: sum((result) => result.professionalTax),
    taxDeductedAtSource: sum((result) => result.taxDeductedAtSource),
    totalDeductions: sum((result) => result.totalDeductions),
    net: sum((result) => result.net),
    employerProvidentFund: sum((result) => result.employerProvidentFund),
    employerStateInsurance: sum((result) => result.employerStateInsurance),
    employerContributions: sum((result) => result.employerContributions),
    costToCompany: sum((result) => result.costToCompany),
  };
}
