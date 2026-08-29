import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAYMENT_PURPOSES } from "@/lib/validation/settlements";

/**
 * A debt the books can take on is a debt the books can settle.
 *
 * A payroll run posts what the month owes and charges the wages to the profit
 * and loss account once, there and then: net pay to the staff, and four
 * withholdings owed to four different authorities. Every one of those is a
 * credit to a liability account.
 *
 * Nothing could debit them. `SALARY_PAYABLE` appeared four times in the whole
 * codebase — the constant, the chart, and payroll resolving it and crediting it
 * — and the payments screen offered supplier, drawings, loan repayment and
 * "other", where other goes to miscellaneous expenses. So a shopkeeper
 * recording the money leaving had two routes and both were wrong: through
 * "other" into miscellaneous expenses, or through the expense form's own
 * `Salary` category straight back into `SALARY_EXPENSE`, which the expenses
 * page invites in as many words ("Rent, electricity, salaries, repairs"). The
 * wages were charged twice and the debts stood for as long as the business ran
 * payroll.
 *
 * The rule is the pairing, not the list: whatever payroll comes to owe, a
 * payment has to be able to pay. A liability added to the run without a purpose
 * that settles it is the same defect again, and this is what says so.
 */

const PAYROLL_SERVICE = "src/server/payroll/payroll-service.ts";
const SETTLEMENT_SERVICE = "src/server/settlements/settlement-service.ts";

/** Liability accounts a payroll run names. */
function payrollLiabilities(): string[] {
  const source = readFileSync(PAYROLL_SERVICE, "utf8");
  const found = new Set<string>();
  for (const match of source.matchAll(/SYSTEM_ACCOUNT\.([A-Z_]*PAYABLE)\b/g)) {
    found.add(match[1]!);
  }
  return [...found].sort();
}

/** Accounts a payment can land on, read from the map that decides it. */
function settleableAccounts(): string[] {
  const source = readFileSync(SETTLEMENT_SERVICE, "utf8");
  const map = source.slice(
    source.indexOf("const PAYMENT_COUNTER"),
    source.indexOf("const PAYMENT_COUNTER_ACCOUNTS"),
  );
  return [...map.matchAll(/SYSTEM_ACCOUNT\.([A-Z_]+)/g)].map(
    (match) => match[1]!,
  );
}

describe("what a payroll run comes to owe", () => {
  it("names enough liabilities for this to mean anything", () => {
    // Five: the staff, the provident fund, the state insurance, the state's
    // professional tax and the tax withheld. A scan that stopped matching would
    // make the check below vacuously true.
    const liabilities = payrollLiabilities();
    expect(liabilities.length).toBeGreaterThanOrEqual(5);
    expect(liabilities).toContain("SALARY_PAYABLE");
  });

  it("can every one of it be paid", () => {
    const settleable = new Set(settleableAccounts());
    const stranded = payrollLiabilities().filter(
      (account) => !settleable.has(account),
    );

    expect(stranded).toEqual([]);
  });

  it("keeps a purpose for the staff and one for each authority", () => {
    // Named rather than counted, because the point is which debts can be
    // settled and not how many entries the map happens to have.
    expect(PAYMENT_PURPOSES).toContain("STAFF_PAY");
    expect(PAYMENT_PURPOSES).toContain("PROVIDENT_FUND");
    expect(PAYMENT_PURPOSES).toContain("EMPLOYEE_INSURANCE");
    expect(PAYMENT_PURPOSES).toContain("PROFESSIONAL_TAX");
    expect(PAYMENT_PURPOSES).toContain("TDS");
  });

  it("does not send any of them to an expense account", () => {
    // The failure this replaces put the money into miscellaneous expenses,
    // which balanced and read as a second month of wages. A purpose that
    // settles a debt must debit that debt.
    const source = readFileSync(SETTLEMENT_SERVICE, "utf8");
    const map = source.slice(
      source.indexOf("const PAYMENT_COUNTER"),
      source.indexOf("const PAYMENT_COUNTER_ACCOUNTS"),
    );

    for (const purpose of [
      "STAFF_PAY",
      "PROVIDENT_FUND",
      "EMPLOYEE_INSURANCE",
      "PROFESSIONAL_TAX",
      "TDS",
    ]) {
      const line = map
        .split("\n")
        .find((entry) => entry.trim().startsWith(`${purpose}:`));
      expect(line).toBeDefined();
      expect(line).toMatch(/PAYABLE/);
    }
  });
});
