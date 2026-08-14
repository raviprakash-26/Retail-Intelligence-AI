import { z } from "zod";
import { isoDate } from "@/lib/validation/date";

/**
 * What a return is allowed to say.
 *
 * A return always names the document it reverses. Under GST a credit note is
 * issued *against an invoice*, and a debit note against a bill — the linkage is
 * what lets the tax be reversed at the rate and place of supply the original
 * carried, rather than at whatever the rate happens to be today.
 *
 * It is also what makes "you cannot return more than you sold" answerable. A
 * free-standing return would leave both of those questions with no source of
 * truth, so the identifier is required rather than optional, even though the
 * table permits null for data migrated from elsewhere.
 *
 * Rates are not accepted from the browser. The line quotes a quantity and the
 * server reads the price, the tax rate and the original cost from the invoice
 * line being returned — the client can choose *what* comes back and *how much
 * of it*, and nothing else.
 */

const quantity = z
  .number()
  .positive("Return at least some of the line")
  .max(1_000_000, "That quantity looks wrong");

export const returnLineSchema = z.object({
  /** The line on the original document being returned, not the product. */
  sourceLineId: z.string().uuid("Choose a line from the original document"),
  quantity,
});

export const salesReturnSchema = z.object({
  saleId: z.string().uuid("Choose the invoice being returned against"),
  returnDate: isoDate,
  reason: z.string().trim().max(500).optional().default(""),
  /** Where the money goes: back to the customer's account, or out of the till. */
  refundMode: z.enum(["CREDIT", "CASH", "BANK"]).default("CREDIT"),
  lines: z
    .array(returnLineSchema)
    .min(1, "A return needs at least one line")
    .max(200, "Split a return this large into several"),
});

export const purchaseReturnSchema = z.object({
  purchaseId: z.string().uuid("Choose the bill being returned against"),
  returnDate: isoDate,
  reason: z.string().trim().max(500).optional().default(""),
  /** Whether the supplier refunds, or the amount comes off what is owed. */
  refundMode: z.enum(["CREDIT", "CASH", "BANK"]).default("CREDIT"),
  lines: z
    .array(returnLineSchema)
    .min(1, "A return needs at least one line")
    .max(200, "Split a return this large into several"),
});

export type ReturnLineInput = z.infer<typeof returnLineSchema>;
export type SalesReturnInput = z.infer<typeof salesReturnSchema>;
export type PurchaseReturnInput = z.infer<typeof purchaseReturnSchema>;
