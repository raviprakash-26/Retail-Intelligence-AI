import "server-only";
import { StockMovementType, VoucherType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { DraftJournalLine } from "@/lib/accounting/double-entry";
import type { InventoryMethod } from "@/lib/inventory/valuation";
import { compare, money, subtract, toStorageString } from "@/lib/money";
import {
  ADJUSTMENT_REASON_LABELS,
  type AdjustmentReason,
  type StockAdjustmentInput,
} from "@/lib/validation/inventory";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { recordAuditLog } from "@/server/audit/audit-log";
import { resolveSystemAccounts } from "@/server/documents/accounts";
import { readPosition, recordInward, recordOutward } from "./stock-service";
import { postingBranchId } from "@/server/company/posting-branch";

/**
 * Bringing the books into line with what is actually on the shelf.
 *
 * Two things make this more than a quantity edit.
 *
 * **Stock lost is a cost, recognised now.** Goods that were bought and will
 * never be sold have already been paid for; leaving them in inventory overstates
 * both the asset and next month's margin, because the loss would otherwise
 * surface as an unexplained gap in cost of sales whenever the count is finally
 * corrected. So an adjustment posts a real entry — stock out, expense in — on
 * the day it is recognised.
 *
 * **Stock found is not income.** It is a correction to an asset that was
 * understated, so it reverses the same expense rather than being credited to
 * revenue. Treating it as income would inflate turnover with goods nobody
 * bought, and on a GST return that is a number with consequences.
 *
 * The count is entered as what was found, never as a difference. A retailer
 * counts what is on the shelf; asking for the delta invites a sign error nobody
 * notices until the stock figure is meaningless.
 */

export const ADJUSTMENT_AUDIT = {
  POSTED: "stock.adjusted",
} as const;

export const ADJUSTMENT_SOURCE_TYPE = "STOCK_ADJUSTMENT";

export class StockAdjustmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "StockAdjustmentError";
  }
}

/** Where the cost of a loss lands, by why it happened. */
const LOSS_ACCOUNT: Record<AdjustmentReason, string> = {
  DAMAGE: SYSTEM_ACCOUNT.DIRECT_EXPENSES,
  THEFT: SYSTEM_ACCOUNT.DIRECT_EXPENSES,
  EXPIRY: SYSTEM_ACCOUNT.DIRECT_EXPENSES,
  COUNT: SYSTEM_ACCOUNT.DIRECT_EXPENSES,
  FOUND: SYSTEM_ACCOUNT.DIRECT_EXPENSES,
};

export type PostedAdjustment = {
  id: string;
  productName: string;
  direction: "in" | "out";
  quantity: string;
  value: string;
  entryNumber: string;
  quantityAfter: string;
};

export async function createStockAdjustment(params: {
  companyId: string;
  branchId: string | null;
  userId: string;
  actorEmail: string;
  input: StockAdjustmentInput;
}): Promise<PostedAdjustment> {
  const { companyId, input } = params;

  return prisma.$transaction(async (tx) => {
    const adjustmentDate = new Date(`${input.adjustmentDate}T00:00:00.000Z`);

    const [product, company] = await Promise.all([
      tx.product.findFirst({
        where: { id: input.productId, companyId },
        select: {
          id: true,
          sku: true,
          name: true,
          isStockTracked: true,
          archivedAt: true,
        },
      }),
      tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { inventoryMethod: true },
      }),
    ]);

    if (!product) {
      throw new StockAdjustmentError(
        "That product could not be found.",
        "NOT_FOUND",
        "productId",
      );
    }
    if (!product.isStockTracked) {
      throw new StockAdjustmentError(
        `${product.name} is not stock tracked, so there is no quantity to correct.`,
        "NOT_TRACKED",
        "productId",
      );
    }
    if (product.archivedAt) {
      throw new StockAdjustmentError(
        `${product.name} is archived. Restore it before correcting its stock.`,
        "ARCHIVED",
        "productId",
      );
    }

    // A branch-restricted member adjusts their own branch; anyone else adjusts
    // the primary one. Stock positions are held per branch, so falling back to
    // "no branch" would read a position of nil and turn every adjustment into
    // an apparent gain of the whole counted quantity.
    const branchId = await postingBranchId(tx, {
      companyId,
      memberBranchId: params.branchId,
    });
    const method = company.inventoryMethod as InventoryMethod;

    const position = await readPosition(tx, {
      companyId,
      productId: product.id,
      branchId,
      method,
    });

    const counted = money(input.countedQuantity);
    const difference = subtract(counted, position.quantity);

    if (difference.isZero()) {
      throw new StockAdjustmentError(
        `The books already say ${position.quantity.toFixed(3)} — there is nothing to correct.`,
        "NO_DIFFERENCE",
        "countedQuantity",
      );
    }

    const reason = ADJUSTMENT_REASON_LABELS[input.reason];
    if (reason.direction === "out" && compare(difference, 0) > 0) {
      throw new StockAdjustmentError(
        `${reason.label} can only reduce stock, but the count is higher than the books. Use "Counted and it differs" or "Found" instead.`,
        "WRONG_DIRECTION",
        "reason",
      );
    }

    const goingOut = compare(difference, 0) < 0;
    const quantity = difference.abs();

    const accountId = await resolveSystemAccounts(tx, companyId, [
      SYSTEM_ACCOUNT.INVENTORY,
      LOSS_ACCOUNT[input.reason],
    ]);

    const narration = `${reason.label} — ${product.name} (${product.sku}): books ${position.quantity.toFixed(
      3,
    )}, counted ${counted.toFixed(3)}`;

    // --- The stock movement -----------------------------------------------
    const movement = goingOut
      ? await recordOutward(tx, {
          companyId,
          productId: product.id,
          branchId,
          method,
          quantity,
          movementType:
            input.reason === "COUNT"
              ? StockMovementType.ADJUSTMENT_OUT
              : StockMovementType.WRITE_OFF,
          movementDate: adjustmentDate,
          sourceType: ADJUSTMENT_SOURCE_TYPE,
          sourceId: product.id,
          notes: input.notes,
          createdById: params.userId,
        })
      : await recordInward(tx, {
          companyId,
          productId: product.id,
          branchId,
          method,
          quantity,
          // Found stock comes back at what the rest of it is worth. Inventing a
          // price would move the average cost on no evidence.
          unitCost:
            compare(position.averageCost, 0) > 0
              ? position.averageCost
              : money(0),
          movementType: StockMovementType.ADJUSTMENT_IN,
          movementDate: adjustmentDate,
          sourceType: ADJUSTMENT_SOURCE_TYPE,
          sourceId: product.id,
          notes: input.notes,
          createdById: params.userId,
        });

    // --- The accounting ----------------------------------------------------
    // Stock found reverses the loss account rather than crediting income: it is
    // a correction to an asset, not something the business earned.
    const lines: DraftJournalLine[] = goingOut
      ? [
          {
            accountId: accountId(LOSS_ACCOUNT[input.reason]),
            debit: movement.value,
            narration: reason.label,
          },
          {
            accountId: accountId(SYSTEM_ACCOUNT.INVENTORY),
            credit: movement.value,
            narration: product.name,
          },
        ]
      : [
          {
            accountId: accountId(SYSTEM_ACCOUNT.INVENTORY),
            debit: movement.value,
            narration: product.name,
          },
          {
            accountId: accountId(LOSS_ACCOUNT[input.reason]),
            credit: movement.value,
            narration: reason.label,
          },
        ];

    // A found item with no established cost is worth nothing on the books, so
    // there is no entry to post — the quantity moves and the value does not.
    const entry = movement.value.isZero()
      ? { id: null, entryNumber: "—" }
      : await postJournalEntry(tx, {
          companyId,
          branchId,
          entryDate: adjustmentDate,
          voucherType: VoucherType.JOURNAL,
          narration,
          referenceNo: product.sku,
          sourceType: ADJUSTMENT_SOURCE_TYPE,
          sourceId: product.id,
          createdById: params.userId,
          isSystem: true,
          lines,
        });

    await recordAuditLog(
      {
        action: ADJUSTMENT_AUDIT.POSTED,
        module: "Inventory",
        companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Product",
        entityId: product.id,
        metadata: {
          sku: product.sku,
          reason: input.reason,
          booksQuantity: toStorageString(position.quantity),
          countedQuantity: toStorageString(counted),
          direction: goingOut ? "out" : "in",
          value: toStorageString(movement.value),
          entryNumber: entry.entryNumber,
          notes: input.notes,
        },
      },
      tx,
    );

    return {
      id: product.id,
      productName: product.name,
      direction: goingOut ? "out" : "in",
      quantity: toStorageString(quantity),
      value: toStorageString(movement.value),
      entryNumber: entry.entryNumber,
      quantityAfter: toStorageString(movement.quantityAfter),
    };
  });
}

/** What the books currently say, so the form can show it beside the count. */
export async function readBookQuantity(params: {
  companyId: string;
  productId: string;
  branchId: string | null;
  method: InventoryMethod;
}): Promise<{ quantity: string; averageCost: string; stockValue: string }> {
  const position = await readPosition(prisma, params);
  return {
    quantity: toStorageString(position.quantity),
    averageCost: toStorageString(position.averageCost),
    stockValue: toStorageString(position.stockValue),
  };
}
