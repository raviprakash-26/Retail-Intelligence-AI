import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { balanceSideLabel, signedBalance } from "@/lib/accounting/double-entry";

/**
 * Which side a balance sits on is decided in one place.
 *
 * A ledger figure is signed against its account's nature, so the sign alone
 * does not say whether it is a debit or a credit — on payables a positive
 * balance is money the shop owes, which is a credit. Three places chose the
 * tag from `amount < 0` and all three were backwards for every credit-nature
 * account in the chart: the ledger heading, and `Signed`, which renders the
 * opening balance, the closing balance and the running balance on every row.
 *
 * The heading was the visible half — `describeBalance` saying "You owe Metro
 * Wholesale this much" directly above a figure tagged "Dr", which says the
 * supplier owes the shop. The rows were the larger half and said nothing at
 * all about being wrong.
 *
 * Neither component is rendered by any test, so nothing would catch the
 * expression being written back. This is a source scan rather than a render
 * test because the rule worth holding is not "the page looks right today" but
 * "there is one function that answers this question".
 */

const TAG_FROM_SIGN =
  /[<>]\s*0\s*\?\s*["'](?:Dr|Cr)["']\s*:\s*["'](?:Dr|Cr)["']/;

/**
 * A ternary that picks Dr or Cr from something other than a balance's sign.
 *
 * Named rather than inferred: reading a *declared* nature is a different
 * question from reading a signed figure, and only one of them is the mistake.
 */
const NOT_A_BALANCE: Record<string, string> = {
  "src/components/master-data/party-manager.tsx":
    "Labels the opening nature the user chose, not a computed balance.",
};

function offenders(): string[] {
  const files = globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() });
  const found: string[] = [];

  for (const file of files) {
    if (file in NOT_A_BALANCE) continue;
    const source = readFileSync(file, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (TAG_FROM_SIGN.test(line)) found.push(`${file}:${index + 1}`);
    }
  }
  return found;
}

describe("the side a balance sits on", () => {
  it("is never decided from the sign alone", () => {
    expect(offenders()).toEqual([]);
  });

  it("reads back what signedBalance wrote", () => {
    // The round trip that matters: a payable credited ₹30,000 nets to a
    // positive signed balance, and has to come back as a credit.
    const payable = signedBalance("CREDIT", 0, 30_000);
    expect(payable.toString()).toBe("30000");
    expect(balanceSideLabel({ nature: "CREDIT", balance: payable })).toBe("Cr");

    // And a receivable debited ₹1,180 comes back as a debit.
    const receivable = signedBalance("DEBIT", 1_180, 0);
    expect(receivable.toString()).toBe("1180");
    expect(balanceSideLabel({ nature: "DEBIT", balance: receivable })).toBe(
      "Dr",
    );

    // The awkward ones: an overpaid supplier and a customer in credit.
    expect(
      balanceSideLabel({
        nature: "CREDIT",
        balance: signedBalance("CREDIT", 30_000, 0),
      }),
    ).toBe("Dr");
    expect(
      balanceSideLabel({
        nature: "DEBIT",
        balance: signedBalance("DEBIT", 0, 1_180),
      }),
    ).toBe("Cr");
  });
});
