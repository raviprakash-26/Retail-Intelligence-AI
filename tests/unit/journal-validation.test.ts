import { describe, expect, it } from "vitest";
import {
  EMPTY_JOURNAL_LINE,
  journalEntrySchema,
  MANUAL_VOUCHER_LABELS,
  MANUAL_VOUCHER_TYPES,
  type JournalEntryInput,
} from "@/lib/validation/journal";

/**
 * A manual entry is the one place a person can move any figure in the business
 * to any other, so the rules that stop them writing nonsense are worth testing
 * exhaustively. The same schema runs in the browser and on the server; these
 * are the cases the form's live totals are meant to catch before a submit and
 * the server catches regardless.
 */

function entry(overrides: Partial<JournalEntryInput> = {}): JournalEntryInput {
  return {
    entryDate: "2026-08-11",
    voucherType: "JOURNAL",
    narration: "Depreciation on the display fridge",
    referenceNo: "",
    lines: [
      { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 1000 },
      { ...EMPTY_JOURNAL_LINE, accountId: "b", credit: 1000 },
    ],
    ...overrides,
  };
}

const messages = (input: JournalEntryInput): string[] => {
  const result = journalEntrySchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
};

describe("a valid entry", () => {
  it("accepts a balanced two-line entry", () => {
    expect(journalEntrySchema.safeParse(entry()).success).toBe(true);
  });

  it("accepts many lines as long as they balance", () => {
    const result = journalEntrySchema.safeParse(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 600 },
          { ...EMPTY_JOURNAL_LINE, accountId: "b", debit: 400 },
          { ...EMPTY_JOURNAL_LINE, accountId: "c", credit: 250 },
          { ...EMPTY_JOURNAL_LINE, accountId: "d", credit: 750 },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts every voucher type it offers, and explains each", () => {
    for (const type of MANUAL_VOUCHER_TYPES) {
      expect(
        journalEntrySchema.safeParse(entry({ voucherType: type })).success,
      ).toBe(true);
      expect(MANUAL_VOUCHER_LABELS[type].label.length).toBeGreaterThan(2);
      expect(MANUAL_VOUCHER_LABELS[type].hint.length).toBeGreaterThan(20);
    }
  });

  it("does not offer sales or purchases as a manual type", () => {
    // A sale entered by hand would move the ledger without moving the stock,
    // without a tax-register row and without a document to show anyone.
    expect(MANUAL_VOUCHER_TYPES as readonly string[]).not.toContain("SALES");
    expect(MANUAL_VOUCHER_TYPES as readonly string[]).not.toContain("PURCHASE");
    expect(MANUAL_VOUCHER_TYPES as readonly string[]).not.toContain("RECEIPT");
    expect(
      journalEntrySchema.safeParse({
        ...entry(),
        voucherType: "SALES",
      }).success,
    ).toBe(false);
  });
});

describe("balance", () => {
  it("refuses an entry where debits exceed credits, naming the gap", () => {
    const issues = messages(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 1500 },
          { ...EMPTY_JOURNAL_LINE, accountId: "b", credit: 1000 },
        ],
      }),
    );
    expect(issues).toContain("Debits exceed credits by 500.00.");
  });

  it("refuses an entry where credits exceed debits, naming the gap", () => {
    const issues = messages(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 100 },
          { ...EMPTY_JOURNAL_LINE, accountId: "b", credit: 250.5 },
        ],
      }),
    );
    expect(issues).toContain("Credits exceed debits by 150.50.");
  });

  it("does not report a difference that is only floating-point noise", () => {
    // 0.1 + 0.2 is not 0.3 in a double. The form works in numbers, so the
    // comparison rounds to paise before deciding the entry is unbalanced.
    const result = journalEntrySchema.safeParse(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 0.1 },
          { ...EMPTY_JOURNAL_LINE, accountId: "b", debit: 0.2 },
          { ...EMPTY_JOURNAL_LINE, accountId: "c", credit: 0.3 },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("refuses an entry with no value at all", () => {
    const issues = messages(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "a" },
          { ...EMPTY_JOURNAL_LINE, accountId: "b" },
        ],
      }),
    );
    expect(issues).toContain("An entry with no value cannot be posted.");
  });
});

describe("line shape", () => {
  it("refuses a line that is both a debit and a credit", () => {
    const issues = messages(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 500, credit: 500 },
          { ...EMPTY_JOURNAL_LINE, accountId: "b", credit: 500, debit: 500 },
        ],
      }),
    );
    expect(issues).toContain(
      "A line is a debit or a credit, not both. Split it in two.",
    );
  });

  it("refuses a line with nothing on either side", () => {
    const issues = messages(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 100 },
          { ...EMPTY_JOURNAL_LINE, accountId: "b", credit: 100 },
          { ...EMPTY_JOURNAL_LINE, accountId: "c" },
        ],
      }),
    );
    expect(issues).toContain("Enter an amount on one side.");
  });

  it("refuses a negative amount and says what to do instead", () => {
    const issues = messages(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: -100 },
          { ...EMPTY_JOURNAL_LINE, accountId: "b", credit: -100 },
        ],
      }),
    );
    expect(issues.join(" ")).toMatch(/other side/i);
  });

  it("refuses fewer than two lines", () => {
    const issues = messages(
      entry({
        lines: [{ ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 100 }],
      }),
    );
    expect(issues).toContain("An entry needs at least two lines.");
  });

  it("refuses a line with no account", () => {
    const issues = messages(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "", debit: 100 },
          { ...EMPTY_JOURNAL_LINE, accountId: "b", credit: 100 },
        ],
      }),
    );
    expect(issues).toContain("Choose an account.");
  });

  it("refuses the same account twice and says to combine", () => {
    const issues = messages(
      entry({
        lines: [
          { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 100 },
          { ...EMPTY_JOURNAL_LINE, accountId: "a", debit: 50 },
          { ...EMPTY_JOURNAL_LINE, accountId: "b", credit: 150 },
        ],
      }),
    );
    expect(issues).toContain(
      "This account is already on the entry. Combine the lines.",
    );
  });

  it("allows the same control account twice for different parties", () => {
    // Writing off two customers' debts in one entry is a real thing to do, and
    // the lines are not duplicates — they move different sub-ledgers.
    const result = journalEntrySchema.safeParse(
      entry({
        lines: [
          {
            ...EMPTY_JOURNAL_LINE,
            accountId: "receivables",
            credit: 100,
            partyId: "sharma",
          },
          {
            ...EMPTY_JOURNAL_LINE,
            accountId: "receivables",
            credit: 200,
            partyId: "lakshmi",
          },
          { ...EMPTY_JOURNAL_LINE, accountId: "baddebt", debit: 300 },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("narration", () => {
  it("requires one, because somebody will read it in a year", () => {
    const issues = messages(entry({ narration: "" }));
    expect(issues.join(" ")).toMatch(/Say what this entry is for/);
  });

  it("refuses a narration too short to mean anything", () => {
    expect(
      journalEntrySchema.safeParse(entry({ narration: "adj" })).success,
    ).toBe(false);
  });

  it("accepts a proper one", () => {
    expect(
      journalEntrySchema.safeParse(entry({ narration: "Year-end accrual" }))
        .success,
    ).toBe(true);
  });
});

describe("the date", () => {
  it("refuses a malformed date", () => {
    expect(
      journalEntrySchema.safeParse(entry({ entryDate: "11-08-2026" })).success,
    ).toBe(false);
  });

  it("refuses a date that does not exist", () => {
    const issues = messages(entry({ entryDate: "2026-02-30" }));
    expect(issues).toContain("That is not a real date.");
  });

  it("accepts a leap day", () => {
    expect(
      journalEntrySchema.safeParse(entry({ entryDate: "2028-02-29" })).success,
    ).toBe(true);
  });
});
