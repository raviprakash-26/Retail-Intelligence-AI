import { z } from "zod";
import { isoDate } from "./date";

/**
 * Receipts and payments.
 *
 * Money in and money out, and — where it matters — which documents it settles.
 * Allocation is not bookkeeping pedantry: it is what makes "who owes me what,
 * and for how long" answerable. A receipt with no allocation still moves the
 * control account correctly; it just leaves the customer's ledger saying they
 * paid something rather than which bill they paid.
 */

export const SETTLEMENT_MODES = [
  "CASH",
  "BANK",
  "UPI",
  "CARD",
  "CHEQUE",
] as const;

export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export const SETTLEMENT_MODE_LABELS: Record<SettlementMode, string> = {
  CASH: "Cash",
  BANK: "Bank transfer",
  UPI: "UPI",
  CARD: "Card",
  CHEQUE: "Cheque",
};

/** Why money came in. Anything but a collection posts to its own account. */
export const RECEIPT_SOURCES = [
  "CUSTOMER",
  "CAPITAL",
  "LOAN",
  "OTHER_INCOME",
] as const;

export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];

export const RECEIPT_SOURCE_LABELS: Record<
  ReceiptSource,
  { label: string; hint: string }
> = {
  CUSTOMER: {
    label: "Customer payment",
    hint: "Settles what a customer owes on their invoices.",
  },
  CAPITAL: {
    label: "Money you put in",
    hint: "Your own money into the business. Not income, and not taxed as such.",
  },
  LOAN: {
    label: "Loan received",
    hint: "Borrowed money. A liability, not income — it has to be paid back.",
  },
  OTHER_INCOME: {
    label: "Other income",
    hint: "Interest, a refund, scrap sales. Income, but not from trading.",
  },
};

/** Why money went out. */
export const PAYMENT_PURPOSES = [
  "SUPPLIER",
  "DRAWINGS",
  "LOAN_REPAYMENT",
  "OTHER",
] as const;

export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const PAYMENT_PURPOSE_LABELS: Record<
  PaymentPurpose,
  { label: string; hint: string }
> = {
  SUPPLIER: {
    label: "Supplier payment",
    hint: "Settles what you owe on their bills.",
  },
  DRAWINGS: {
    label: "Money you took out",
    hint: "Your own money out of the business. Not an expense — it reduces your capital.",
  },
  LOAN_REPAYMENT: {
    label: "Loan repayment",
    hint: "Reduces what you have borrowed. The interest is an expense; this is not.",
  },
  OTHER: {
    label: "Other payment",
    hint: "Anything else. Goes to miscellaneous expenses.",
  },
};

const amount = z
  .number({ error: "Enter the amount." })
  .gt(0, "An amount has to be more than zero.")
  .max(99_99_99_999, "That amount looks too large — check the figure.")
  .finite();

export const allocationSchema = z.object({
  documentId: z.string().min(1),
  amount: z
    .number()
    .min(0, "An allocation cannot be negative.")
    .max(99_99_99_999)
    .finite(),
});

export type AllocationInput = z.infer<typeof allocationSchema>;

/**
 * Both schemas use the same field names — `kind`, `partyId`, `date` — so one
 * form can drive both. The names diverge again at the database, where a receipt
 * has a `source` and a customer and a payment has a `purpose` and a supplier;
 * the services translate. Forcing the form to know that difference would mean
 * two near-identical forms, and two places for a bug to live.
 */
export const receiptSchema = z
  .object({
    kind: z.enum(RECEIPT_SOURCES),
    partyId: z.string().optional().or(z.literal("")),
    date: isoDate,
    paymentMode: z.enum(SETTLEMENT_MODES),
    amount,
    referenceNo: z.string().trim().max(60).optional().or(z.literal("")),
    notes: z.string().trim().max(500).optional().or(z.literal("")),
    allocations: z.array(allocationSchema).max(200),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "CUSTOMER" && !data.partyId) {
      ctx.addIssue({
        code: "custom",
        path: ["partyId"],
        message: "Choose the customer who paid.",
      });
    }
    if (data.kind !== "CUSTOMER" && data.allocations.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["allocations"],
        message: "Only a customer payment can be set against invoices.",
      });
    }
  });

export type ReceiptInput = z.infer<typeof receiptSchema>;

export const paymentSchema = z
  .object({
    kind: z.enum(PAYMENT_PURPOSES),
    partyId: z.string().optional().or(z.literal("")),
    date: isoDate,
    paymentMode: z.enum(SETTLEMENT_MODES),
    amount,
    referenceNo: z.string().trim().max(60).optional().or(z.literal("")),
    notes: z.string().trim().max(500).optional().or(z.literal("")),
    allocations: z.array(allocationSchema).max(200),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "SUPPLIER" && !data.partyId) {
      ctx.addIssue({
        code: "custom",
        path: ["partyId"],
        message: "Choose the supplier being paid.",
      });
    }
    if (data.kind !== "SUPPLIER" && data.allocations.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["allocations"],
        message: "Only a supplier payment can be set against bills.",
      });
    }
  });

export type PaymentInput = z.infer<typeof paymentSchema>;

export const voidSettlementSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "Say why this is being voided.")
    .max(300, "Keep the reason under 300 characters."),
});

export type VoidSettlementInput = z.infer<typeof voidSettlementSchema>;
