import { z } from "zod";
import { isoDate } from "./date";

/**
 * Sales invoice input.
 *
 * Deliberately small: an invoice describes *what was sold and how it was paid
 * for*. Every money figure on the finished document — taxable value, CGST,
 * SGST, IGST, round-off, total — is computed by the tax engine from these
 * inputs and is never accepted from the client. A browser that posts its own
 * totals would be a browser that decides what a business earned.
 */

export const PAYMENT_MODES = [
  "CASH",
  "BANK",
  "UPI",
  "CARD",
  "CHEQUE",
  "CREDIT",
] as const;

export type PaymentModeInput = (typeof PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentModeInput, string> = {
  CASH: "Cash",
  BANK: "Bank transfer",
  UPI: "UPI",
  CARD: "Card",
  CHEQUE: "Cheque",
  CREDIT: "On credit",
};

export const saleLineSchema = z.object({
  productId: z.string().min(1, "Choose a product."),
  description: z.string().trim().max(200).optional().or(z.literal("")),
  quantity: z
    .number({ error: "Enter a quantity." })
    .gt(0, "Quantity must be more than zero.")
    .max(99_99_999, "That quantity looks too large — check the figure.")
    .finite(),
  rate: z
    .number({ error: "Enter a rate." })
    .min(0, "A rate cannot be negative.")
    .max(99_99_99_999, "That rate looks too large — check the figure.")
    .finite(),
  discountPercent: z
    .number()
    .min(0, "A discount cannot be negative.")
    .max(100, "A discount cannot exceed 100%.")
    .finite(),
});

export type SaleLineInput = z.infer<typeof saleLineSchema>;

export const saleSchema = z
  .object({
    customerId: z.string().optional().or(z.literal("")),
    invoiceDate: isoDate,
    paymentMode: z.enum(PAYMENT_MODES),
    /** Customer's state code; decides CGST + SGST versus IGST. */
    placeOfSupply: z.string().trim().max(2).optional().or(z.literal("")),
    /** Rates already include tax — an MRP-priced counter sale. */
    priceIncludesTax: z.boolean(),
    notes: z.string().trim().max(500).optional().or(z.literal("")),
    lines: z
      .array(saleLineSchema)
      .min(1, "Add at least one item.")
      .max(200, "An invoice can hold 200 lines."),
  })
  .superRefine((data, ctx) => {
    // A credit sale is a receivable, and a receivable has to be owed by
    // somebody. Without a customer there is no sub-ledger to collect it from.
    if (data.paymentMode === "CREDIT" && !data.customerId) {
      ctx.addIssue({
        code: "custom",
        path: ["customerId"],
        message: "Choose a customer — a credit sale has to be owed by someone.",
      });
    }

    const seen = new Set<string>();
    for (const [index, line] of data.lines.entries()) {
      if (seen.has(line.productId)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "productId"],
          message:
            "This product is already on the invoice. Change the quantity on that line instead.",
        });
      }
      seen.add(line.productId);
    }
  });

export type SaleInput = z.infer<typeof saleSchema>;

export const voidSaleSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "Say why this invoice is being voided.")
    .max(300, "Keep the reason under 300 characters."),
});

export type VoidSaleInput = z.infer<typeof voidSaleSchema>;
