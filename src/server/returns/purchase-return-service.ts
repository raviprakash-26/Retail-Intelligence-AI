import "server-only";
import {
  DocumentStatus,
  GstDirection,
  PartyType,
  StockMovementType,
  VoucherType,
} from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { DraftJournalLine } from "@/lib/accounting/double-entry";
import type { InventoryMethod } from "@/lib/inventory/valuation";
import { totalLines, type GstLineResult } from "@/lib/tax/gst";
import {
  add,
  compare,
  isZero,
  money,
  multiply,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";
import type { PurchaseReturnInput } from "@/lib/validation/returns";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { recordAuditLog } from "@/server/audit/audit-log";
import { resolveSystemAccounts } from "@/server/documents/accounts";
import { writeGstRows } from "@/server/documents/gst-register";
import { recordOutward } from "@/server/inventory/stock-service";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";
import { assertNoRepeatedLines, ReturnError } from "@/server/returns/errors";
import type { ReturnableLine } from "@/server/returns/return-queries";

/**
 * Purchase returns — a debit note against a supplier's bill.
 *
 * The mirror of a sales return, with one asymmetry that matters. A sale posts
 * revenue to an income account, so returns go to a contra-revenue account and
 * gross sales stay visible. A purchase under perpetual inventory posts no
 * expense at all — it debits Inventory. So returning goods **credits Inventory**
 * rather than crediting a "purchase returns" income account, because the stock
 * is physically gone and an asset that is not there must not remain on the
 * balance sheet.
 *
 * The second asymmetry follows from the first. Stock leaves at what the
 * valuation method says it is worth today, exactly as any other issue does —
 * that is what keeps the Inventory account and the stock ledger in agreement,
 * which this product reconciles and shows. But the supplier refunds the price
 * on the bill. The difference between the two is real and has to land
 * somewhere: freight capitalised into the cost of goods that have since gone
 * back is money spent on nothing, and it is recognised as a direct cost rather
 * than left inflating the value of stock that is no longer on the shelf.
 */

export type PostedPurchaseReturn = {
  id: string;
  returnNumber: string;
  entryNumber: string;
  totalAmount: string;
  stockValueRemoved: string;
};

async function returnedSoFar(
  tx: DbClient,
  purchaseId: string,
): Promise<Map<string, Decimal>> {
  const rows = await tx.purchaseReturnItem.findMany({
    where: {
      purchaseReturn: { purchaseId, status: DocumentStatus.POSTED },
    },
    select: { productId: true, lineNumber: true, quantity: true },
  });

  const used = new Map<string, Decimal>();
  for (const row of rows) {
    const key = `${row.productId}#${row.lineNumber}`;
    used.set(key, add(used.get(key) ?? money(0), row.quantity));
  }
  return used;
}

export async function createPurchaseReturn(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  branchId: string | null;
  input: PurchaseReturnInput;
}): Promise<PostedPurchaseReturn> {
  const { companyId, input } = params;

  return prisma.$transaction(
    async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { inventoryMethod: true, stateCode: true },
      });
      const method = company.inventoryMethod as InventoryMethod;
      const returnDate = new Date(`${input.returnDate}T00:00:00.000Z`);

      const purchase = await tx.purchase.findFirst({
        where: { id: input.purchaseId, companyId },
        select: {
          id: true,
          billNumber: true,
          billDate: true,
          status: true,
          branchId: true,
          supplyType: true,
          // Whether this bill's input tax was claimed. It decides both what the
          // debit note may give back and what the goods were valued at.
          itcEligible: true,
          supplier: { select: { id: true, name: true, gstin: true } },
          items: {
            select: {
              id: true,
              productId: true,
              lineNumber: true,
              hsnCode: true,
              taxRateId: true,
              quantity: true,
              rate: true,
              taxPercent: true,
              unitCost: true,
              product: { select: { name: true, isStockTracked: true } },
            },
          },
        },
      });

      if (!purchase) {
        throw new ReturnError("That bill could not be found.", "NOT_FOUND");
      }
      if (purchase.status !== DocumentStatus.POSTED) {
        throw new ReturnError(
          "That bill has been voided, so there is nothing to return against.",
          "NOT_POSTED",
        );
      }
      if (returnDate.getTime() < purchase.billDate.getTime()) {
        throw new ReturnError(
          "A return cannot be dated before the bill it is returning.",
          "DATE_BEFORE_INVOICE",
        );
      }

      assertNoRepeatedLines(input.lines, "bill");

      const itemById = new Map(purchase.items.map((item) => [item.id, item]));
      const already = await returnedSoFar(tx, purchase.id);

      const priced = input.lines.map((line) => {
        const item = itemById.get(line.sourceLineId);
        if (!item) {
          throw new ReturnError(
            "One of those lines is not on that bill.",
            "LINE_NOT_ON_INVOICE",
          );
        }

        const key = `${item.productId}#${item.lineNumber}`;
        const outstanding = subtract(
          item.quantity,
          already.get(key) ?? money(0),
        );
        const quantity = money(line.quantity);

        if (compare(quantity, outstanding) > 0) {
          throw new ReturnError(
            `More ${item.product.name} is being returned than was bought on that line — ${toStorageString(outstanding)} remains.`,
            "OVER_RETURN",
          );
        }

        const taxable = multiply(quantity, item.rate);
        const half =
          purchase.supplyType === "INTRA_STATE"
            ? item.taxPercent.toNumber() / 2
            : 0;
        const full =
          purchase.supplyType === "INTER_STATE"
            ? item.taxPercent.toNumber()
            : 0;

        const result: GstLineResult & {
          hsnCode: string | null;
          taxRateId: string | null;
        } = {
          grossAmount: taxable,
          discountAmount: money(0),
          taxableAmount: taxable,
          taxPercent: money(item.taxPercent),
          cgstAmount: multiply(taxable, half / 100),
          sgstAmount: multiply(taxable, half / 100),
          igstAmount: multiply(taxable, full / 100),
          cessAmount: money(0),
          lineTotal: money(0),
          hsnCode: item.hsnCode,
          taxRateId: item.taxRateId,
        };
        result.lineTotal = add(
          result.taxableAmount,
          result.cgstAmount,
          result.sgstAmount,
          result.igstAmount,
        );

        return { item, quantity, line: result };
      });

      const totals = totalLines(priced.map((entry) => entry.line));

      const fiscalYear = await ensureFiscalYearFor(tx, {
        companyId,
        date: returnDate,
      });

      const returnNumber = await allocateDocumentNumber(tx, {
        companyId,
        key: "PURCHASE_RETURN",
        fiscalYearId: fiscalYear.id,
      });

      const branchId = params.branchId ?? purchase.branchId;

      const purchaseReturn = await tx.purchaseReturn.create({
        data: {
          companyId,
          purchaseId: purchase.id,
          supplierId: purchase.supplier?.id ?? null,
          returnNumber,
          returnDate,
          status: DocumentStatus.POSTED,
          reason: input.reason || null,
          subTotal: toStorageString(totals.subTotal),
          taxableAmount: toStorageString(totals.taxableAmount),
          cgstAmount: toStorageString(totals.cgstAmount),
          sgstAmount: toStorageString(totals.sgstAmount),
          igstAmount: toStorageString(totals.igstAmount),
          cessAmount: toStorageString(totals.cessAmount),
          roundOff: toStorageString(totals.roundOff),
          totalAmount: toStorageString(totals.totalAmount),
          createdById: params.userId,
          postedAt: new Date(),
          items: {
            create: priced.map((entry) => ({
              companyId,
              productId: entry.item.productId,
              lineNumber: entry.item.lineNumber,
              quantity: toStorageString(entry.quantity),
              rate: toStorageString(entry.item.rate),
              taxableAmount: toStorageString(entry.line.taxableAmount),
              taxPercent: toStorageString(entry.line.taxPercent),
              cgstAmount: toStorageString(entry.line.cgstAmount),
              sgstAmount: toStorageString(entry.line.sgstAmount),
              igstAmount: toStorageString(entry.line.igstAmount),
              cessAmount: toStorageString(entry.line.cessAmount),
              lineTotal: toStorageString(entry.line.lineTotal),
              unitCost: toStorageString(entry.item.unitCost),
            })),
          },
        },
        select: { id: true },
      });

      // --- Stock off the shelf, at what the books say it is worth -----------
      let stockValueRemoved = money(0);
      for (const entry of priced) {
        if (!entry.item.product.isStockTracked) continue;
        const movement = await recordOutward(tx, {
          companyId,
          productId: entry.item.productId,
          branchId,
          method,
          quantity: entry.quantity,
          movementType: StockMovementType.PURCHASE_RETURN,
          movementDate: returnDate,
          sourceType: "PurchaseReturn",
          sourceId: purchaseReturn.id,
          referenceNo: returnNumber,
        });
        // What the stock ledger actually took out — not what the bill said it
        // cost. The two agree unless freight was capitalised or the average has
        // moved, and the Inventory account has to match the stock ledger.
        stockValueRemoved = add(stockValueRemoved, movement.value);
      }

      // --- The entry --------------------------------------------------------
      const accountId = await resolveSystemAccounts(tx, companyId, [
        SYSTEM_ACCOUNT.CASH,
        SYSTEM_ACCOUNT.BANK,
        SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
        SYSTEM_ACCOUNT.INVENTORY,
        SYSTEM_ACCOUNT.DIRECT_EXPENSES,
        SYSTEM_ACCOUNT.GST_INPUT_CGST,
        SYSTEM_ACCOUNT.GST_INPUT_SGST,
        SYSTEM_ACCOUNT.GST_INPUT_IGST,
        SYSTEM_ACCOUNT.GST_INPUT_CESS,
        SYSTEM_ACCOUNT.ROUND_OFF,
      ]);

      const refundAccount =
        input.refundMode === "CASH"
          ? accountId(SYSTEM_ACCOUNT.CASH)
          : input.refundMode === "BANK"
            ? accountId(SYSTEM_ACCOUNT.BANK)
            : accountId(SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE);

      const lines: DraftJournalLine[] = [
        {
          accountId: refundAccount,
          debit: totals.totalAmount,
          narration: purchase.supplier
            ? `Debit note to ${purchase.supplier.name}`
            : "Purchase return",
          ...(input.refundMode === "CREDIT"
            ? {
                partyType: PartyType.SUPPLIER,
                partyId: purchase.supplier?.id ?? null,
              }
            : {}),
        },
      ];

      // Only credit that was actually claimed can be given up.
      //
      // The bill decided this, and the same rule read from the other side: a
      // purchase posts input tax as an asset only when it can be set off, and
      // otherwise lands it onto the cost of the goods because it "must not
      // appear here as well, or the bill would be counted twice". Where nothing
      // was ever debited, crediting it back puts a credit balance on an asset
      // account that came from nowhere — and the tax, which is sitting inside
      // the stock value, then leaves a second time as a cost.
      const returnedTax = add(
        totals.cgstAmount,
        totals.sgstAmount,
        totals.igstAmount,
        totals.cessAmount,
      );

      if (purchase.itcEligible) {
        const taxLines: Array<[string, Decimal]> = [
          [SYSTEM_ACCOUNT.GST_INPUT_CGST, totals.cgstAmount],
          [SYSTEM_ACCOUNT.GST_INPUT_SGST, totals.sgstAmount],
          [SYSTEM_ACCOUNT.GST_INPUT_IGST, totals.igstAmount],
          [SYSTEM_ACCOUNT.GST_INPUT_CESS, totals.cessAmount],
        ];
        for (const [key, amount] of taxLines) {
          if (!isZero(amount)) {
            lines.push({ accountId: accountId(key), credit: amount });
          }
        }
      }

      // Rounded to the rupee like the bill it reverses, with the fraction
      // posted rather than absorbed. A debit note is raised for the whole
      // rupee the supplier will credit.
      if (!isZero(totals.roundOff)) {
        lines.push(
          totals.roundOff.greaterThan(0)
            ? {
                accountId: accountId(SYSTEM_ACCOUNT.ROUND_OFF),
                credit: totals.roundOff,
              }
            : {
                accountId: accountId(SYSTEM_ACCOUNT.ROUND_OFF),
                debit: totals.roundOff.abs(),
              },
        );
      }

      if (!isZero(stockValueRemoved)) {
        lines.push({
          accountId: accountId(SYSTEM_ACCOUNT.INVENTORY),
          credit: stockValueRemoved,
          narration: "Stock returned to supplier",
        });
      }

      // Whatever the supplier refunds and the shelf gives up do not match, the
      // difference is a real cost or credit — most often freight capitalised
      // into goods that have since gone back, which bought nothing.
      // Against what the bill actually put into stock, which is the taxable
      // amount when the credit was claimed and the tax-inclusive figure when it
      // was not — the same choice `createPurchase` makes when it values the
      // goods coming in. Comparing tax-inclusive stock against a tax-exclusive
      // refund reports the whole of an unclaimable tax as a cost of returning.
      const costBasis = purchase.itcEligible
        ? totals.taxableAmount
        : add(totals.taxableAmount, returnedTax);
      const difference = subtract(stockValueRemoved, costBasis);
      if (!isZero(difference)) {
        lines.push(
          compare(difference, 0) > 0
            ? {
                accountId: accountId(SYSTEM_ACCOUNT.DIRECT_EXPENSES),
                debit: difference,
                narration: "Cost carried on returned goods",
              }
            : {
                accountId: accountId(SYSTEM_ACCOUNT.DIRECT_EXPENSES),
                credit: difference.abs(),
                narration: "Cost carried on returned goods",
              },
        );
      }

      const entry = await postJournalEntry(tx, {
        companyId,
        branchId,
        entryDate: returnDate,
        voucherType: VoucherType.PURCHASE_RETURN,
        narration: `Purchase return ${returnNumber} against ${purchase.billNumber}`,
        referenceNo: returnNumber,
        sourceType: "PurchaseReturn",
        sourceId: purchaseReturn.id,
        createdById: params.userId,
        lines,
      });

      await tx.purchaseReturn.update({
        where: { id: purchaseReturn.id },
        data: { journalEntryId: entry.id },
      });

      await writeGstRows(tx, {
        companyId,
        direction: GstDirection.INWARD,
        documentType: "PurchaseReturn",
        documentId: purchaseReturn.id,
        documentNumber: returnNumber,
        documentDate: returnDate,
        supplyType: purchase.supplyType,
        // An inward supply lands in the buyer's own state.
        placeOfSupply: company.stateCode,
        partyName: purchase.supplier?.name ?? "Supplier",
        partyGstin: purchase.supplier?.gstin ?? null,
        // What the bill said, not what a debit note usually is. A negative row
        // marked eligible is credit being surrendered, and surrendering a claim
        // nobody made understates the month's claimable credit and overstates
        // the cash payable that the set-off arrives at.
        itcEligible: purchase.itcEligible,
        lines: priced.map((entry) => entry.line),
        sign: -1,
      });

      await recordAuditLog(
        {
          action: "purchase_return.created",
          module: "Purchases",
          companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          entityType: "PurchaseReturn",
          entityId: purchaseReturn.id,
          metadata: {
            returnNumber,
            against: purchase.billNumber,
            total: toStorageString(totals.totalAmount),
          },
        },
        tx,
      );

      return {
        id: purchaseReturn.id,
        returnNumber,
        entryNumber: entry.entryNumber,
        totalAmount: toStorageString(totals.totalAmount),
        stockValueRemoved: toStorageString(stockValueRemoved),
      };
    },
    { timeout: 20_000 },
  );
}

/** What is still returnable on a bill. One implementation, as with sales. */
export async function returnableBillLines(params: {
  companyId: string;
  purchaseId: string;
}): Promise<ReturnableLine[]> {
  const purchase = await prisma.purchase.findFirst({
    where: { id: params.purchaseId, companyId: params.companyId },
    select: {
      id: true,
      items: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          productId: true,
          lineNumber: true,
          quantity: true,
          rate: true,
          product: { select: { name: true, sku: true } },
        },
      },
    },
  });
  if (!purchase) return [];

  const already = await returnedSoFar(prisma, purchase.id);

  return purchase.items.map((item) => {
    const used =
      already.get(`${item.productId}#${item.lineNumber}`) ?? money(0);
    return {
      lineId: item.id,
      productName: item.product.name,
      sku: item.product.sku,
      originalQuantity: toStorageString(item.quantity),
      alreadyReturned: toStorageString(used),
      returnable: toStorageString(subtract(item.quantity, used)),
      rate: toStorageString(item.rate),
    };
  });
}
