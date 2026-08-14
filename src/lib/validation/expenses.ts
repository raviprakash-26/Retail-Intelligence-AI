import { z } from "zod";
import { isoDate } from "./date";

/**
 * Expense input.
 *
 * An expense is a single amount against a single category, not a document with
 * lines — a rent receipt has one figure on it. What makes it interesting is the
 * two questions the form has to ask honestly:
 *
 *   • **Is this an expense at all?** A fridge bought for the shop is an asset
 *     that wears out over years, not a cost of this month. Recording it as an
 *     expense understates profit now and overstates it later.
 *   • **Can the GST be claimed?** Only if the business is registered under the
 *     regular scheme and the payee actually charged it.
 */

export const EXPENSE_PAYMENT_MODES = [
  "CASH",
  "BANK",
  "UPI",
  "CARD",
  "CHEQUE",
  "CREDIT",
] as const;

export type ExpensePaymentMode = (typeof EXPENSE_PAYMENT_MODES)[number];

export const EXPENSE_PAYMENT_LABELS: Record<ExpensePaymentMode, string> = {
  CASH: "Cash",
  BANK: "Bank transfer",
  UPI: "UPI",
  CARD: "Card",
  CHEQUE: "Cheque",
  CREDIT: "Not paid yet",
};

/** GST slabs an expense receipt can carry. */
export const EXPENSE_TAX_RATES = [0, 5, 12, 18, 28] as const;

export const expenseSchema = z
  .object({
    categoryId: z.string().min(1, "Choose a category."),
    expenseDate: isoDate,
    paymentMode: z.enum(EXPENSE_PAYMENT_MODES),
    /** A registered supplier, when the payee is one. */
    supplierId: z.string().optional().or(z.literal("")),
    /** Free text for anyone who is not. */
    payeeName: z.string().trim().max(160).optional().or(z.literal("")),
    amount: z
      .number({ error: "Enter the amount." })
      .gt(0, "An expense has to be more than zero.")
      .max(99_99_99_999, "That amount looks too large — check the figure.")
      .finite(),
    taxPercent: z
      .number()
      .min(0, "A rate cannot be negative.")
      .max(28, "GST does not go above 28%.")
      .finite(),
    /** The amount written down is what was paid, tax included. */
    amountIncludesTax: z.boolean(),
    claimInputCredit: z.boolean(),
    /** Route to fixed assets and depreciate, rather than to the P&L. */
    isCapitalExpenditure: z.boolean(),
    /** Required for a capital item: what it is, for the asset register. */
    assetName: z.string().trim().max(160).optional().or(z.literal("")),
    assetUsefulLifeMonths: z
      .number()
      .int("Enter whole months.")
      .min(1, "An asset lasts at least a month.")
      .max(600, "Fifty years is the maximum."),
    referenceNo: z.string().trim().max(60).optional().or(z.literal("")),
    notes: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    // An unpaid expense is owed to somebody, and a payable with no party is a
    // figure nobody can chase.
    if (data.paymentMode === "CREDIT" && !data.supplierId) {
      ctx.addIssue({
        code: "custom",
        path: ["supplierId"],
        message:
          "Choose a supplier — something not yet paid has to be owed to someone.",
      });
    }

    if (data.isCapitalExpenditure && !data.assetName && !data.payeeName) {
      ctx.addIssue({
        code: "custom",
        path: ["assetName"],
        message: "Name the asset so it can be tracked and depreciated.",
      });
    }
  });

export type ExpenseInput = z.infer<typeof expenseSchema>;

export const voidExpenseSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "Say why this expense is being voided.")
    .max(300, "Keep the reason under 300 characters."),
});

export type VoidExpenseInput = z.infer<typeof voidExpenseSchema>;
