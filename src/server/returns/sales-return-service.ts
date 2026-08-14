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
import type { SalesReturnInput } from "@/lib/validation/returns";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { recordAuditLog } from "@/server/audit/audit-log";
import { resolveSystemAccounts } from "@/server/documents/accounts";
import { writeGstRows } from "@/server/documents/gst-register";
import { recordInward } from "@/server/inventory/stock-service";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import { ReturnError } from "@/server/returns/errors";

/**
 * Sales returns — a credit note against an invoice.
 *
 * Four consequences, in one transaction, exactly mirroring the sale it
 * reverses:
 *
 *   1. the return and its lines are written,
 *   2. stock comes back in at what it originally cost,
 *   3. a balanced entry reverses the revenue, the tax and the cost of sales,
 *   4. the GST register gains negative rows, which is what a credit note is.
 *
 * **Everything is read from the invoice, not from the browser.** The client
 * chooses which lines come back and how many of each; the price, the tax rate,
 * the place of supply and the original unit cost all come from the line being
 * returned. That is not only a trust boundary — it is the only way the
 * accounting reverses cleanly. Returning at today's price would leave revenue
 * misstated, and returning at today's average cost would leave a phantom profit
 * or loss on goods that merely came back.
 *
 * A return is not a void. Voiding says the invoice never should have existed;
 * a return says the sale happened and some of it came back. Both leave the
 * original entry untouched, because a ledger that can be edited is not a
 * ledger.
 */

export type PostedSalesReturn = {
  id: string;
  returnNumber: string;
  entryNumber: string;
  totalAmount: string;
  costOfGoodsReturned: string;
};

/** How much of each invoice line has already been returned. */
async function returnedSoFar(
  tx: DbClient,
  saleId: string,
): Promise<Map<string, Decimal>> {
  const rows = await tx.salesReturnItem.findMany({
    where: {
      salesReturn: { saleId, status: DocumentStatus.POSTED },
    },
    select: { productId: true, lineNumber: true, quantity: true },
  });

  // Keyed by the invoice line the return was raised against. The line number
  // is carried across deliberately so a product appearing twice on one invoice
  // — same item, two prices — is tracked per line rather than in aggregate.
  const used = new Map<string, Decimal>();
  for (const row of rows) {
    const key = `${row.productId}#${row.lineNumber}`;
    used.set(key, add(used.get(key) ?? money(0), row.quantity));
  }
  return used;
}

export async function createSalesReturn(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  branchId: string | null;
  input: SalesReturnInput;
}): Promise<PostedSalesReturn> {
  const { companyId, input } = params;

  return prisma.$transaction(
    async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { inventoryMethod: true },
      });
      const method = company.inventoryMethod as InventoryMethod;
      const returnDate = new Date(`${input.returnDate}T00:00:00.000Z`);

      const sale = await tx.sale.findFirst({
        where: { id: input.saleId, companyId },
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          status: true,
          branchId: true,
          supplyType: true,
          placeOfSupply: true,
          paymentMode: true,
          customer: { select: { id: true, name: true, gstin: true } },
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

      if (!sale) {
        throw new ReturnError("That invoice could not be found.", "NOT_FOUND");
      }
      if (sale.status !== DocumentStatus.POSTED) {
        // A voided invoice has already had its revenue, tax and stock
        // reversed in full. Returning against it would reverse them twice.
        throw new ReturnError(
          "That invoice has been voided, so there is nothing to return against.",
          "NOT_POSTED",
        );
      }
      if (returnDate.getTime() < sale.invoiceDate.getTime()) {
        throw new ReturnError(
          "A return cannot be dated before the invoice it is returning.",
          "DATE_BEFORE_INVOICE",
        );
      }

      const itemById = new Map(sale.items.map((item) => [item.id, item]));
      const already = await returnedSoFar(tx, sale.id);

      // --- What is coming back, priced as it was sold ------------------------
      const priced = input.lines.map((line, index) => {
        const item = itemById.get(line.sourceLineId);
        if (!item) {
          throw new ReturnError(
            "One of those lines is not on that invoice.",
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
            `More ${item.product.name} is being returned than was sold on that line — ${toStorageString(outstanding)} remains.`,
            "OVER_RETURN",
          );
        }

        // The rate, the tax and the cost all come from the invoice line. The
        // browser chose the quantity and nothing else.
        const taxable = multiply(quantity, item.rate);
        const cgstRate =
          sale.supplyType === "INTRA_STATE"
            ? item.taxPercent.toNumber() / 2
            : 0;
        const igstRate =
          sale.supplyType === "INTER_STATE" ? item.taxPercent.toNumber() : 0;

        const result: GstLineResult & {
          hsnCode: string | null;
          taxRateId: string | null;
        } = {
          grossAmount: taxable,
          discountAmount: money(0),
          taxableAmount: taxable,
          taxPercent: money(item.taxPercent),
          cgstAmount: multiply(taxable, cgstRate / 100),
          sgstAmount: multiply(taxable, cgstRate / 100),
          igstAmount: multiply(taxable, igstRate / 100),
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

        return { item, index, quantity, line: result };
      });

      const totals = totalLines(priced.map((entry) => entry.line));

      const costOfGoodsReturned = priced.reduce(
        (total, entry) =>
          add(total, multiply(entry.quantity, entry.item.unitCost)),
        money(0),
      );

      // --- The document -----------------------------------------------------
      // The return series restarts each financial year, like every other
      // document series except the master-record ones — so the year the return
      // falls in has to be resolved, not assumed.
      const fiscalYear = await tx.fiscalYear.findFirst({
        where: {
          companyId,
          startDate: { lte: returnDate },
          endDate: { gte: returnDate },
        },
        select: { id: true },
      });

      const returnNumber = await allocateDocumentNumber(tx, {
        companyId,
        key: "SALES_RETURN",
        fiscalYearId: fiscalYear?.id ?? null,
      });

      const branchId = params.branchId ?? sale.branchId;

      const salesReturn = await tx.salesReturn.create({
        data: {
          companyId,
          saleId: sale.id,
          customerId: sale.customer?.id ?? null,
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
          totalAmount: toStorageString(totals.totalAmount),
          costOfGoodsReturned: toStorageString(costOfGoodsReturned),
          createdById: params.userId,
          postedAt: new Date(),
          items: {
            create: priced.map((entry) => ({
              companyId,
              productId: entry.item.productId,
              // The invoice's line number, kept so a second return against the
              // same invoice can tell which line it is drawing down.
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

      // --- Stock back on the shelf, at what it cost -------------------------
      for (const entry of priced) {
        if (!entry.item.product.isStockTracked) continue;
        await recordInward(tx, {
          companyId,
          productId: entry.item.productId,
          branchId,
          method,
          quantity: entry.quantity,
          // The cost captured when the sale issued it. Bringing it back at
          // today's average would invent a profit or loss on goods that only
          // travelled to the customer and back.
          unitCost: entry.item.unitCost,
          movementType: StockMovementType.SALES_RETURN,
          movementDate: returnDate,
          sourceType: "SalesReturn",
          sourceId: salesReturn.id,
          referenceNo: returnNumber,
        });
      }

      // --- The entry --------------------------------------------------------
      const accountId = await resolveSystemAccounts(tx, companyId, [
        SYSTEM_ACCOUNT.CASH,
        SYSTEM_ACCOUNT.BANK,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
        SYSTEM_ACCOUNT.SALES_RETURNS,
        SYSTEM_ACCOUNT.GST_OUTPUT_CGST,
        SYSTEM_ACCOUNT.GST_OUTPUT_SGST,
        SYSTEM_ACCOUNT.GST_OUTPUT_IGST,
        SYSTEM_ACCOUNT.GST_OUTPUT_CESS,
        SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD,
        SYSTEM_ACCOUNT.INVENTORY,
      ]);

      const refundAccount =
        input.refundMode === "CASH"
          ? accountId(SYSTEM_ACCOUNT.CASH)
          : input.refundMode === "BANK"
            ? accountId(SYSTEM_ACCOUNT.BANK)
            : accountId(SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE);

      const lines: DraftJournalLine[] = [
        {
          // Contra-revenue, not a debit to Sales. The gross figure a shop sold
          // and the amount that came back are both worth seeing; netting them
          // into one number hides the return rate entirely.
          accountId: accountId(SYSTEM_ACCOUNT.SALES_RETURNS),
          debit: totals.taxableAmount,
          narration: `Return against ${sale.invoiceNumber}`,
        },
      ];

      const taxLines: Array<[string, Decimal]> = [
        [SYSTEM_ACCOUNT.GST_OUTPUT_CGST, totals.cgstAmount],
        [SYSTEM_ACCOUNT.GST_OUTPUT_SGST, totals.sgstAmount],
        [SYSTEM_ACCOUNT.GST_OUTPUT_IGST, totals.igstAmount],
        [SYSTEM_ACCOUNT.GST_OUTPUT_CESS, totals.cessAmount],
      ];
      for (const [key, amount] of taxLines) {
        if (!isZero(amount)) {
          lines.push({ accountId: accountId(key), debit: amount });
        }
      }

      lines.push({
        accountId: refundAccount,
        credit: totals.totalAmount,
        narration: sale.customer
          ? `Credit note to ${sale.customer.name}`
          : "Counter refund",
        ...(input.refundMode === "CREDIT"
          ? {
              partyType: PartyType.CUSTOMER,
              partyId: sale.customer?.id ?? null,
            }
          : {}),
      });

      if (!isZero(costOfGoodsReturned)) {
        lines.push(
          {
            accountId: accountId(SYSTEM_ACCOUNT.INVENTORY),
            debit: costOfGoodsReturned,
            narration: "Stock returned",
          },
          {
            accountId: accountId(SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD),
            credit: costOfGoodsReturned,
            narration: "Cost of goods returned",
          },
        );
      }

      const entry = await postJournalEntry(tx, {
        companyId,
        branchId,
        entryDate: returnDate,
        voucherType: VoucherType.SALES_RETURN,
        narration: `Sales return ${returnNumber} against ${sale.invoiceNumber}`,
        referenceNo: returnNumber,
        sourceType: "SalesReturn",
        sourceId: salesReturn.id,
        createdById: params.userId,
        lines,
      });

      await tx.salesReturn.update({
        where: { id: salesReturn.id },
        data: { journalEntryId: entry.id },
      });

      // --- The register -----------------------------------------------------
      // A credit note is a negative outward supply. The register already knows
      // how to write one: the same rows the invoice wrote, with the sign
      // flipped, appended rather than edited.
      await writeGstRows(tx, {
        companyId,
        direction: GstDirection.OUTWARD,
        documentType: "SalesReturn",
        documentId: salesReturn.id,
        documentNumber: returnNumber,
        documentDate: returnDate,
        supplyType: sale.supplyType,
        placeOfSupply: sale.placeOfSupply,
        partyName: sale.customer?.name ?? "Counter customer",
        partyGstin: sale.customer?.gstin ?? null,
        lines: priced.map((entry) => entry.line),
        sign: -1,
      });

      await recordAuditLog(
        {
          action: "sales_return.created",
          module: "Sales",
          companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          entityType: "SalesReturn",
          entityId: salesReturn.id,
          metadata: {
            returnNumber,
            against: sale.invoiceNumber,
            total: toStorageString(totals.totalAmount),
          },
        },
        tx,
      );

      return {
        id: salesReturn.id,
        returnNumber,
        entryNumber: entry.entryNumber,
        totalAmount: toStorageString(totals.totalAmount),
        costOfGoodsReturned: toStorageString(costOfGoodsReturned),
      };
    },
    { timeout: 20_000 },
  );
}

/**
 * What is still returnable on an invoice.
 *
 * Used by the form so somebody cannot start a return they will be refused, and
 * by the service as the source of the over-return check. One implementation,
 * so the two cannot disagree.
 */
export async function returnableLines(params: {
  companyId: string;
  saleId: string;
}): Promise<
  Array<{
    lineId: string;
    productName: string;
    sku: string;
    sold: string;
    alreadyReturned: string;
    returnable: string;
    rate: string;
  }>
> {
  const sale = await prisma.sale.findFirst({
    where: { id: params.saleId, companyId: params.companyId },
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
  if (!sale) return [];

  const already = await returnedSoFar(prisma, sale.id);

  return sale.items.map((item) => {
    const used =
      already.get(`${item.productId}#${item.lineNumber}`) ?? money(0);
    return {
      lineId: item.id,
      productName: item.product.name,
      sku: item.product.sku,
      sold: toStorageString(item.quantity),
      alreadyReturned: toStorageString(used),
      returnable: toStorageString(subtract(item.quantity, used)),
      rate: toStorageString(item.rate),
    };
  });
}
