import { z } from "zod";
import { isoDate } from "./date";

/**
 * A manual journal entry.
 *
 * Most entries in this system are produced by a document — a sale, a bill, a
 * receipt — and that is the right way round: the transaction is the fact and
 * the entry follows from it. But some things are genuinely only accounting.
 * Depreciation, a prepayment released over the year, a bad debt written off, a
 * correction that has to be made without pretending the original never
 * happened: none of these have a document, and an accountant who cannot post
 * them is an accountant who keeps a second set of books in a spreadsheet.
 *
 * So this exists, deliberately narrow. It posts through the same engine every
 * other module uses, it balances or it does not post, and it is marked as
 * manual so the audit trail can tell it apart from an entry the system derived.
 */

/** What a manual entry can be. Sales and purchases are not on the list. */
export const MANUAL_VOUCHER_TYPES = [
  "JOURNAL",
  "CONTRA",
  "DEPRECIATION",
] as const;

export type ManualVoucherType = (typeof MANUAL_VOUCHER_TYPES)[number];

export const MANUAL_VOUCHER_LABELS: Record<
  ManualVoucherType,
  { label: string; hint: string }
> = {
  JOURNAL: {
    label: "Journal",
    hint: "An adjustment with no document behind it — an accrual, a write-off, a correction.",
  },
  CONTRA: {
    label: "Contra",
    hint: "Money between your own accounts — cash banked, or drawn from the bank.",
  },
  DEPRECIATION: {
    label: "Depreciation",
    hint: "Writing down what a fixed asset is worth as it is used up.",
  },
};

const sideAmount = z
  .number()
  .min(0, "An amount cannot be negative. Put it on the other side instead.")
  .max(99_99_99_999, "That amount looks too large — check the figure.")
  .finite();

export const journalLineSchema = z.object({
  accountId: z.string().min(1, "Choose an account."),
  debit: sideAmount,
  credit: sideAmount,
  narration: z.string().trim().max(200).optional().or(z.literal("")),
  /**
   * Who the line belongs to, when the account is a control account.
   *
   * A receivable that belongs to nobody can never be chased, aged or settled;
   * it just sits in the total making the ageing report wrong. The server
   * requires this whenever the account carries a party type.
   */
  partyId: z.string().optional().or(z.literal("")),
});

export type JournalLineInput = z.infer<typeof journalLineSchema>;

export const journalEntrySchema = z
  .object({
    entryDate: isoDate,
    voucherType: z.enum(MANUAL_VOUCHER_TYPES),
    narration: z
      .string()
      .trim()
      .min(5, "Say what this entry is for. Someone will read it in a year.")
      .max(300, "Keep the narration under 300 characters."),
    referenceNo: z.string().trim().max(60).optional().or(z.literal("")),
    lines: z
      .array(journalLineSchema)
      .min(2, "An entry needs at least two lines."),
  })
  .superRefine((data, ctx) => {
    let debit = 0;
    let credit = 0;

    data.lines.forEach((line, index) => {
      const hasDebit = line.debit > 0;
      const hasCredit = line.credit > 0;

      if (hasDebit && hasCredit) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "credit"],
          message: "A line is a debit or a credit, not both. Split it in two.",
        });
      }
      if (!hasDebit && !hasCredit) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "debit"],
          message: "Enter an amount on one side.",
        });
      }
      debit += line.debit;
      credit += line.credit;
    });

    // Rounded to paise before comparing: the form works in numbers, and
    // 0.1 + 0.2 is not 0.3 in one.
    const difference = Math.round((debit - credit) * 100) / 100;
    if (difference !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message:
          difference > 0
            ? `Debits exceed credits by ${difference.toFixed(2)}.`
            : `Credits exceed debits by ${Math.abs(difference).toFixed(2)}.`,
      });
    }

    if (debit === 0 && credit === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "An entry with no value cannot be posted.",
      });
    }

    const seen = new Set<string>();
    data.lines.forEach((line, index) => {
      if (!line.accountId) return;
      const key = `${line.accountId}|${line.partyId ?? ""}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "accountId"],
          message: "This account is already on the entry. Combine the lines.",
        });
      }
      seen.add(key);
    });
  });

export type JournalEntryInput = z.infer<typeof journalEntrySchema>;

export const voidJournalEntrySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "Say why this is being reversed.")
    .max(300, "Keep the reason under 300 characters."),
});

export type VoidJournalEntryInput = z.infer<typeof voidJournalEntrySchema>;

/** A blank line, so the form and its tests agree on what one looks like. */
export const EMPTY_JOURNAL_LINE: JournalLineInput = {
  accountId: "",
  debit: 0,
  credit: 0,
  narration: "",
  partyId: "",
};
