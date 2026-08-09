import { describe, expect, it } from "vitest";
import { VoucherType } from "@prisma/client";
import {
  assertBalanced,
  balanceSide,
  condenseLines,
  signedBalance,
  trialBalanceIsBalanced,
  UnbalancedEntryError,
  validateJournalEntry,
  type DraftJournalEntry,
} from "@/lib/accounting/double-entry";

const DATE = new Date("2026-08-09T00:00:00.000Z");

function entry(
  lines: DraftJournalEntry["lines"],
  overrides: Partial<DraftJournalEntry> = {},
): DraftJournalEntry {
  return {
    entryDate: DATE,
    voucherType: VoucherType.JOURNAL,
    lines,
    ...overrides,
  };
}

const CASH = "acc-cash";
const SALES = "acc-sales";
const CGST = "acc-cgst";
const SGST = "acc-sgst";
const RECEIVABLE = "acc-ar";

describe("validateJournalEntry — acceptance", () => {
  it("accepts a balanced two-line entry", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: CASH, debit: 1000 },
        { accountId: SALES, credit: 1000 },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDebit.toString()).toBe("1000");
    expect(result.value.totalCredit.toString()).toBe("1000");
    expect(result.value.lines.map((line) => line.lineNumber)).toEqual([1, 2]);
  });

  it("accepts a multi-line entry with tax splits", () => {
    // A ₹45,000 credit sale at 18% GST: the shape the sales module produces.
    const result = validateJournalEntry(
      entry([
        { accountId: RECEIVABLE, debit: "53100" },
        { accountId: SALES, credit: "45000" },
        { accountId: CGST, credit: "4050" },
        { accountId: SGST, credit: "4050" },
      ]),
    );

    expect(result.ok).toBe(true);
  });

  it("balances amounts that would drift under float arithmetic", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: CASH, debit: 0.1 },
        { accountId: CASH, debit: 0.2 },
        { accountId: SALES, credit: 0.3 },
      ]),
    );

    expect(result.ok).toBe(true);
  });

  it("carries party attribution through to the validated lines", () => {
    const result = validateJournalEntry(
      entry([
        {
          accountId: RECEIVABLE,
          debit: 500,
          partyType: "CUSTOMER",
          partyId: "cus-1",
        },
        { accountId: SALES, credit: 500 },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines[0]?.partyId).toBe("cus-1");
    expect(result.value.lines[1]?.partyId).toBeNull();
  });
});

describe("validateJournalEntry — rejection", () => {
  it("rejects an entry whose debits and credits differ", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: CASH, debit: 1000 },
        { accountId: SALES, credit: 900 },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.code === "UNBALANCED");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("100.00");
  });

  it("rejects an entry that is off by a single paisa", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: CASH, debit: "1000.00" },
        { accountId: SALES, credit: "999.99" },
      ]),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a single-line entry", () => {
    const result = validateJournalEntry(
      entry([{ accountId: CASH, debit: 100 }]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("TOO_FEW_LINES");
  });

  it("rejects a line carrying both a debit and a credit", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: CASH, debit: 100, credit: 40 },
        { accountId: SALES, credit: 60 },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("TWO_SIDED_LINE");
  });

  it("rejects negative amounts rather than treating them as the other side", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: CASH, debit: -100 },
        { accountId: SALES, debit: 100 },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("NEGATIVE_AMOUNT");
  });

  it("rejects a line with no amount on either side", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: CASH, debit: 100 },
        { accountId: SALES, credit: 100 },
        { accountId: CGST },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("EMPTY_LINE");
  });

  it("rejects an entry with no monetary value", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: CASH, debit: 0 },
        { accountId: SALES, credit: 0 },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("ZERO_VALUE_ENTRY");
  });

  it("rejects a line with no account", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: "", debit: 100 },
        { accountId: SALES, credit: 100 },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("MISSING_ACCOUNT");
  });

  it("rejects an invalid entry date", () => {
    const result = validateJournalEntry(
      entry(
        [
          { accountId: CASH, debit: 100 },
          { accountId: SALES, credit: 100 },
        ],
        { entryDate: new Date("not a date") },
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("INVALID_DATE");
  });

  it("reports every problem at once rather than only the first", () => {
    const result = validateJournalEntry(
      entry([
        { accountId: "", debit: -100 },
        { accountId: SALES, credit: 50 },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(1);
  });
});

describe("assertBalanced", () => {
  it("returns the normalised entry when valid", () => {
    const value = assertBalanced(
      entry([
        { accountId: CASH, debit: 100 },
        { accountId: SALES, credit: 100 },
      ]),
    );
    expect(value.totalDebit.toString()).toBe("100");
  });

  it("throws with every issue attached when invalid", () => {
    expect(() =>
      assertBalanced(
        entry([
          { accountId: CASH, debit: 100 },
          { accountId: SALES, credit: 90 },
        ]),
      ),
    ).toThrow(UnbalancedEntryError);

    try {
      assertBalanced(
        entry([
          { accountId: CASH, debit: 100 },
          { accountId: SALES, credit: 90 },
        ]),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(UnbalancedEntryError);
      expect((error as UnbalancedEntryError).issues).toHaveLength(1);
    }
  });
});

describe("condenseLines", () => {
  it("merges repeated postings to the same account and side", () => {
    const lines = condenseLines([
      { accountId: CGST, credit: 90 },
      { accountId: CGST, credit: 180 },
      { accountId: CGST, credit: 45 },
      { accountId: SALES, credit: 3500 },
    ]);

    expect(lines).toHaveLength(2);
    const cgst = lines.find((line) => line.accountId === CGST);
    expect(cgst?.credit?.toString()).toBe("315");
  });

  it("nets a debit and a credit to the same account down to one side", () => {
    const lines = condenseLines([
      { accountId: CASH, debit: 500 },
      { accountId: CASH, credit: 200 },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.debit?.toString()).toBe("300");
    expect(lines[0]?.credit?.toString()).toBe("0");
  });

  it("drops a pair that nets to nothing", () => {
    const lines = condenseLines([
      { accountId: CASH, debit: 500 },
      { accountId: CASH, credit: 500 },
    ]);

    expect(lines).toHaveLength(0);
  });

  it("keeps party-attributed lines separate so sub-ledgers stay resolvable", () => {
    const lines = condenseLines([
      {
        accountId: RECEIVABLE,
        debit: 100,
        partyType: "CUSTOMER",
        partyId: "a",
      },
      {
        accountId: RECEIVABLE,
        debit: 200,
        partyType: "CUSTOMER",
        partyId: "b",
      },
    ]);

    expect(lines).toHaveLength(2);
  });

  it("preserves the entry's balance", () => {
    const original = [
      { accountId: RECEIVABLE, debit: "53100" },
      { accountId: SALES, credit: "45000" },
      { accountId: CGST, credit: "2025" },
      { accountId: CGST, credit: "2025" },
      { accountId: SGST, credit: "4050" },
    ];

    const condensed = condenseLines(original);
    const result = validateJournalEntry(entry(condensed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDebit.toString()).toBe("53100");
  });
});

describe("signedBalance", () => {
  it("increases a debit-nature account on the debit side", () => {
    expect(signedBalance("DEBIT", 1000, 400).toString()).toBe("600");
  });

  it("increases a credit-nature account on the credit side", () => {
    expect(signedBalance("CREDIT", 400, 1000).toString()).toBe("600");
  });

  it("reports a negative balance when an account is overdrawn", () => {
    // Cash credited more than debited: a negative cash position, which the
    // audit rules must be able to see rather than have silently flipped.
    expect(signedBalance("DEBIT", 100, 500).toString()).toBe("-400");
  });
});

describe("balanceSide", () => {
  it("places a net debit in the debit column", () => {
    const side = balanceSide(1000, 400);
    expect(side.debit.toString()).toBe("600");
    expect(side.credit.toString()).toBe("0");
  });

  it("places a net credit in the credit column", () => {
    const side = balanceSide(400, 1000);
    expect(side.debit.toString()).toBe("0");
    expect(side.credit.toString()).toBe("600");
  });

  it("reports where a balance actually sits, not where its nature expects", () => {
    // A supplier who has been paid in advance carries a debit balance. The
    // trial balance must show that, not force it to the credit column.
    const side = balanceSide(5000, 2000);
    expect(side.debit.toString()).toBe("3000");
  });
});

describe("trialBalanceIsBalanced", () => {
  it("confirms a balanced trial balance", () => {
    const result = trialBalanceIsBalanced([
      { debit: "45000", credit: 0 },
      { debit: "285000", credit: 0 },
      { debit: "108460", credit: 0 },
      { debit: "120000", credit: 0 },
      { debit: 0, credit: "558460" },
    ]);

    expect(result.balanced).toBe(true);
    expect(result.difference.isZero()).toBe(true);
    expect(result.totalDebit.toString()).toBe("558460");
  });

  it("reports the difference when it does not balance", () => {
    const result = trialBalanceIsBalanced([
      { debit: "1000", credit: 0 },
      { debit: 0, credit: "999.50" },
    ]);

    expect(result.balanced).toBe(false);
    expect(result.difference.toString()).toBe("0.5");
  });

  it("treats an empty trial balance as balanced", () => {
    const result = trialBalanceIsBalanced([]);
    expect(result.balanced).toBe(true);
  });
});
