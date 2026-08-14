import { z } from "zod";
import { isoDate } from "./date";

/**
 * Correcting what the books say is on the shelf.
 *
 * A physical count almost never matches the ledger exactly. Stock is dropped,
 * spoiled, taken, miscounted at the till, or recorded against the wrong
 * product. Pretending otherwise leaves a retailer with a stock figure they know
 * is wrong and no honest way to fix it — so they stop trusting the system, or
 * they fix it by editing history, which is worse.
 *
 * An adjustment is therefore a first-class transaction: it says what was
 * counted, why it differs, and it posts real accounting. Stock lost is an
 * expense the moment it is recognised, not a quantity that quietly evaporates.
 */

/** Why the count differs. Each posts to a different account. */
export const ADJUSTMENT_REASONS = [
  "DAMAGE",
  "THEFT",
  "EXPIRY",
  "COUNT",
  "FOUND",
] as const;

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const ADJUSTMENT_REASON_LABELS: Record<
  AdjustmentReason,
  { label: string; hint: string; direction: "out" | "either" }
> = {
  DAMAGE: {
    label: "Damaged",
    hint: "Broken, spoiled or otherwise unsellable. Written off as a cost.",
    direction: "out",
  },
  THEFT: {
    label: "Stolen or missing",
    hint: "Gone, and not through a sale. Written off as a cost.",
    direction: "out",
  },
  EXPIRY: {
    label: "Past its date",
    hint: "Expired stock taken off the shelf. Written off as a cost.",
    direction: "out",
  },
  COUNT: {
    label: "Counted and it differs",
    hint: "A physical count found more or less than the books said.",
    direction: "either",
  },
  FOUND: {
    label: "Found",
    hint: "Stock that existed but was never recorded — a missed delivery, a misplaced box.",
    direction: "either",
  },
};

export const stockAdjustmentSchema = z
  .object({
    productId: z.string().min(1, "Choose a product."),
    adjustmentDate: isoDate,
    reason: z.enum(ADJUSTMENT_REASONS),
    /**
     * What the count actually found, not the difference.
     *
     * Asking for a difference invites a sign error nobody notices — a retailer
     * counts what is on the shelf, so that is what the form asks for and the
     * system works out which way it goes.
     */
    countedQuantity: z
      .number({ error: "Enter what you counted." })
      .min(0, "A count cannot be negative.")
      .max(9_99_99_999, "That quantity looks too large — check the figure.")
      .finite(),
    notes: z
      .string()
      .trim()
      .min(5, "Say what happened. Someone will ask about this later.")
      .max(300, "Keep the note under 300 characters."),
  })
  .superRefine((data, ctx) => {
    const reason = ADJUSTMENT_REASON_LABELS[data.reason];
    // A write-off reason can only reduce stock; letting "Damaged" add some
    // would produce an entry whose narration contradicts its own direction.
    if (reason.direction === "out" && data.countedQuantity < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["countedQuantity"],
        message: "A count cannot be negative.",
      });
    }
  });

export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
