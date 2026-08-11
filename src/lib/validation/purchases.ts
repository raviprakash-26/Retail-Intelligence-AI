import { z } from "zod";
import { isoDate } from "./date";

/**
 * Supplier bill input.
 *
 * The mirror of a sales invoice: the client says what was bought, from whom and
 * how it was paid for, and the server works out the tax, the landed cost and
 * the accounting. No total crosses the wire.
 *
 * One field has no counterpart on the sales side — the supplier's own bill
 * number. It is how a business proves which document it is recording, and it is
 * what makes paying the same bill twice detectable.
 */

export const PURCHASE_PAYMENT_MODES = [
  "CREDIT",
  "CASH",
  "BANK",
  "UPI",
  "CARD",
  "CHEQUE",
] as const;

export type PurchasePaymentMode = (typeof PURCHASE_PAYMENT_MODES)[number];

export const PURCHASE_PAYMENT_LABELS: Record<PurchasePaymentMode, string> = {
  CREDIT: "On credit",
  CASH: "Cash",
  BANK: "Bank transfer",
  UPI: "UPI",
  CARD: "Card",
  CHEQUE: "Cheque",
};

export const purchaseLineSchema = z.object({
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

export type PurchaseLineInput = z.infer<typeof purchaseLineSchema>;

export const purchaseSchema = z
  .object({
    supplierId: z.string().min(1, "Choose a supplier."),
    supplierBillNo: z
      .string()
      .trim()
      .max(60, "That reference is too long.")
      .optional()
      .or(z.literal("")),
    billDate: isoDate,
    paymentMode: z.enum(PURCHASE_PAYMENT_MODES),
    /** Rates on the supplier's bill already include GST. */
    priceIncludesTax: z.boolean(),
    /**
     * Whether the tax on this bill can be set against tax collected on sales.
     * Off means it is part of what the goods cost.
     */
    claimInputCredit: z.boolean(),
    notes: z.string().trim().max(500).optional().or(z.literal("")),
    lines: z
      .array(purchaseLineSchema)
      .min(1, "Add at least one item.")
      .max(200, "A bill can hold 200 lines."),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const [index, line] of data.lines.entries()) {
      if (seen.has(line.productId)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "productId"],
          message:
            "This product is already on the bill. Change the quantity on that line instead.",
        });
      }
      seen.add(line.productId);
    }
  });

export type PurchaseInput = z.infer<typeof purchaseSchema>;

export const voidPurchaseSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "Say why this bill is being voided.")
    .max(300, "Keep the reason under 300 characters."),
});

export type VoidPurchaseInput = z.infer<typeof voidPurchaseSchema>;
