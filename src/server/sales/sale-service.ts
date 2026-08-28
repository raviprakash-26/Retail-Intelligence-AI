import "server-only";
import {
  DocumentStatus,
  GstDirection,
  PartyType,
  Prisma,
  StockMovementType,
  VoucherType,
  type PaymentMode,
} from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { DraftJournalLine } from "@/lib/accounting/double-entry";
import type { InventoryMethod } from "@/lib/inventory/valuation";
import { InsufficientStockError } from "@/lib/inventory/valuation";
import {
  computeLine,
  resolveSupplyType,
  totalLines,
  type SupplyType,
} from "@/lib/tax/gst";
import {
  type Decimal,
  add,
  compare,
  isZero,
  money,
  subtract,
  toStorageString,
} from "@/lib/money";
import type { SaleInput } from "@/lib/validation/sales";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import {
  afterUnappliedCredit,
  settledByNotes,
  unappliedCreditByParty,
} from "@/server/settlements/outstanding";
import { recordAuditLog } from "@/server/audit/audit-log";
import { resolveSystemAccounts } from "@/server/documents/accounts";
import { writeGstRows } from "@/server/documents/gst-register";
import { reversePostedEntry } from "@/server/documents/reversal";
import { recordInward, recordOutward } from "@/server/inventory/stock-service";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";
import { owedByParty } from "@/server/settlements/outstanding";
import { MasterDataError } from "@/server/master-data/errors";
import { postingBranchId } from "@/server/company/posting-branch";

/**
 * Sales invoices.
 *
 * One entry point, one transaction, four consequences — and either all of them
 * land or none do:
 *
 *   1. the invoice and its lines are written,
 *   2. stock leaves at what it actually cost,
 *   3. a balanced journal entry records the revenue, the tax and the cost, and
 *   4. the GST register gains the outward supply the return will be built from.
 *
 * Nothing here trusts a figure from the browser. The client sends products,
 * quantities, rates and a discount; every total is computed from those by the
 * tax engine. An invoice whose totals arrived over the wire would be an invoice
 * the customer's browser decided.
 */

export const SALE_AUDIT = {
  POSTED: "sale.posted",
  VOIDED: "sale.voided",
} as const;

export const SALE_SOURCE = "SALE";
export const SALE_VOID_SOURCE = "SALE_VOID";

export class SaleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "SaleError";
  }
}

/** Where the money lands when an invoice is settled at the counter. */
const SETTLEMENT_ACCOUNT: Record<PaymentMode, string | null> = {
  CASH: SYSTEM_ACCOUNT.CASH,
  BANK: SYSTEM_ACCOUNT.BANK,
  // Card and UPI settle into the bank, usually a day or two later. Treating
  // them as bank rather than cash keeps the cash tin reconcilable against what
  // is actually in it.
  UPI: SYSTEM_ACCOUNT.BANK,
  CARD: SYSTEM_ACCOUNT.BANK,
  CHEQUE: SYSTEM_ACCOUNT.BANK,
  CREDIT: null,
  OTHER: null,
};

type ResolvedProduct = {
  id: string;
  name: string;
  sku: string;
  hsnCode: string | null;
  isStockTracked: boolean;
  unitCode: string;
  taxRateId: string | null;
  taxPercent: Decimal;
  cessPercent: Decimal;
};

async function resolveProducts(
  tx: DbClient,
  companyId: string,
  productIds: readonly string[],
): Promise<Map<string, ResolvedProduct>> {
  const products = await tx.product.findMany({
    where: { companyId, id: { in: [...productIds] } },
    select: {
      id: true,
      name: true,
      sku: true,
      hsnCode: true,
      isStockTracked: true,
      archivedAt: true,
      unit: { select: { code: true } },
      taxRateId: true,
      taxRate: { select: { ratePercent: true, cessPercent: true } },
    },
  });

  const map = new Map<string, ResolvedProduct>();
  for (const product of products) {
    if (product.archivedAt) {
      throw new SaleError(
        `${product.name} is archived. Restore it before selling it.`,
        "PRODUCT_ARCHIVED",
      );
    }
    map.set(product.id, {
      id: product.id,
      name: product.name,
      sku: product.sku,
      hsnCode: product.hsnCode,
      isStockTracked: product.isStockTracked,
      unitCode: product.unit.code,
      taxRateId: product.taxRateId,
      taxPercent: money(product.taxRate?.ratePercent ?? 0),
      cessPercent: money(product.taxRate?.cessPercent ?? 0),
    });
  }

  for (const id of productIds) {
    if (!map.has(id)) {
      // An id from another tenant resolves to nothing here, which is the same
      // answer as an id that never existed.
      throw new SaleError(
        "A product on this invoice could not be found.",
        "NOT_FOUND",
      );
    }
  }

  return map;
}

export type PostedSale = {
  id: string;
  invoiceNumber: string;
  totalAmount: string;
  supplyType: SupplyType;
  entryNumber: string;
};

export async function createSale(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  branchId: string | null;
  input: SaleInput;
}): Promise<PostedSale> {
  const { companyId, input } = params;

  return prisma.$transaction(
    async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: {
          stateCode: true,
          gstRegistration: true,
          inventoryMethod: true,
        },
      });

      const method = company.inventoryMethod as InventoryMethod;
      const invoiceDate = new Date(`${input.invoiceDate}T00:00:00.000Z`);

      const branchId = await postingBranchId(tx, {
        companyId,
        memberBranchId: params.branchId,
      });

      // --- Party and place of supply ------------------------------------
      const customer = input.customerId
        ? await tx.customer.findFirst({
            where: { id: input.customerId, companyId },
            select: {
              id: true,
              name: true,
              gstin: true,
              stateCode: true,
              creditDays: true,
              creditLimit: true,
              archivedAt: true,
            },
          })
        : null;

      if (input.customerId && !customer) {
        throw new SaleError(
          "That customer could not be found.",
          "NOT_FOUND",
          "customerId",
        );
      }
      if (customer?.archivedAt) {
        throw new SaleError(
          `${customer.name} is archived. Restore them before invoicing.`,
          "CUSTOMER_ARCHIVED",
          "customerId",
        );
      }

      const placeOfSupply =
        input.placeOfSupply || customer?.stateCode || company.stateCode || null;

      const supplyType = resolveSupplyType({
        registration: company.gstRegistration,
        sellerStateCode: company.stateCode,
        placeOfSupplyStateCode: placeOfSupply,
      });

      // --- Tax ------------------------------------------------------------
      const products = await resolveProducts(
        tx,
        companyId,
        input.lines.map((line) => line.productId),
      );

      const computed = input.lines.map((line) => {
        const product = products.get(line.productId);
        if (!product) {
          throw new SaleError(
            "A product on this invoice could not be found.",
            "NOT_FOUND",
          );
        }
        const result = computeLine(
          {
            quantity: line.quantity,
            rate: line.rate,
            discountPercent: line.discountPercent,
            taxPercent: product.taxPercent,
            cessPercent: product.cessPercent,
            priceIncludesTax: input.priceIncludesTax,
          },
          supplyType,
        );
        return { line, product, result };
      });

      const totals = totalLines(computed.map((entry) => entry.result));

      if (!totals.totalAmount.greaterThan(0)) {
        throw new SaleError(
          "This invoice comes to nothing. Check the quantities and rates.",
          "ZERO_TOTAL",
        );
      }

      // --- Document number -------------------------------------------------
      const fiscalYear = await ensureFiscalYearFor(tx, {
        companyId,
        date: invoiceDate,
      });

      const invoiceNumber = await allocateDocumentNumber(tx, {
        companyId,
        key: "SALE",
        fiscalYearId: fiscalYear.id,
      });

      // --- Credit limit -----------------------------------------------------
      //
      // Only a credit sale extends credit. Money taken at the counter changes
      // nothing about what a customer is trusted with, so a limit has nothing
      // to say about it.
      //
      // Deliberately after the invoice number. Allocating one takes a row lock
      // on the company's sale sequence, so a second invoice to the same
      // customer waits there rather than reading the same balance and slipping
      // under the same limit. A rolled-back insert releases its number, so
      // refusing here costs nothing and leaves no gap in the series — which is
      // the thing a tax officer asks about.
      //
      // The figure is the control account's balance for this customer, which is
      // what the ageing report, the reminder and the customer statement all
      // quote. A refusal measured against a number none of those show is a
      // refusal nobody can argue with.
      if (customer && input.paymentMode === "CREDIT") {
        const limit = money(customer.creditLimit);
        if (limit.greaterThan(0)) {
          const owed = await owedByParty(tx, {
            companyId,
            side: "RECEIVABLE",
            partyId: customer.id,
          });
          const after = add(owed, totals.totalAmount);
          if (after.greaterThan(limit)) {
            throw new SaleError(
              `${customer.name} owes ${owed.toFixed(2)}, and this invoice would take them to ${after.toFixed(2)} against a credit limit of ${limit.toFixed(2)}. Take a payment against what is outstanding, raise the limit, or invoice this one for cash.`,
              "CREDIT_LIMIT_EXCEEDED",
              "customerId",
            );
          }
        }
      }

      const dueDate =
        input.paymentMode === "CREDIT" && customer
          ? new Date(
              invoiceDate.getTime() + customer.creditDays * 24 * 60 * 60 * 1000,
            )
          : null;

      const settledNow = input.paymentMode !== "CREDIT";

      const sale = await tx.sale.create({
        data: {
          companyId,
          branchId,
          customerId: customer?.id ?? null,
          invoiceNumber,
          invoiceDate,
          dueDate,
          status: DocumentStatus.POSTED,
          paymentMode: input.paymentMode,
          supplyType,
          placeOfSupply,
          subTotal: toStorageString(totals.subTotal),
          discountAmount: toStorageString(totals.discountAmount),
          taxableAmount: toStorageString(totals.taxableAmount),
          cgstAmount: toStorageString(totals.cgstAmount),
          sgstAmount: toStorageString(totals.sgstAmount),
          igstAmount: toStorageString(totals.igstAmount),
          cessAmount: toStorageString(totals.cessAmount),
          roundOff: toStorageString(totals.roundOff),
          totalAmount: toStorageString(totals.totalAmount),
          paidAmount: toStorageString(settledNow ? totals.totalAmount : 0),
          notes: input.notes || null,
          postedAt: new Date(),
          createdById: params.userId,
        },
        select: { id: true, invoiceNumber: true },
      });

      // --- Stock, and what it cost -----------------------------------------
      let costOfGoodsSold = money(0);

      for (const [index, entry] of computed.entries()) {
        let unitCost = money(0);

        if (entry.product.isStockTracked) {
          try {
            const movement = await recordOutward(tx, {
              companyId,
              productId: entry.product.id,
              branchId,
              method,
              quantity: entry.line.quantity,
              movementType: StockMovementType.SALE,
              movementDate: invoiceDate,
              sourceType: SALE_SOURCE,
              sourceId: sale.id,
              referenceNo: invoiceNumber,
              createdById: params.userId,
            });
            unitCost = movement.unitCost;
            costOfGoodsSold = add(costOfGoodsSold, movement.value);
          } catch (error) {
            if (error instanceof InsufficientStockError) {
              // Named, with the figures, because "insufficient stock" on an
              // invoice with fifteen lines is not something anyone can act on.
              throw new SaleError(
                `Only ${error.available.toString()} ${entry.product.unitCode} of ${entry.product.name} are in stock; this invoice needs ${error.requested.toString()}.`,
                "INSUFFICIENT_STOCK",
                `lines.${index}.quantity`,
              );
            }
            throw error;
          }
        }

        await tx.saleItem.create({
          data: {
            companyId,
            saleId: sale.id,
            productId: entry.product.id,
            taxRateId: entry.product.taxRateId,
            lineNumber: index + 1,
            description: entry.line.description || entry.product.name,
            hsnCode: entry.product.hsnCode,
            quantity: toStorageString(entry.line.quantity),
            rate: toStorageString(entry.line.rate),
            discountPercent: toStorageString(entry.line.discountPercent),
            discountAmount: toStorageString(entry.result.discountAmount),
            taxableAmount: toStorageString(entry.result.taxableAmount),
            taxPercent: toStorageString(entry.result.taxPercent),
            cgstAmount: toStorageString(entry.result.cgstAmount),
            sgstAmount: toStorageString(entry.result.sgstAmount),
            igstAmount: toStorageString(entry.result.igstAmount),
            cessAmount: toStorageString(entry.result.cessAmount),
            lineTotal: toStorageString(entry.result.lineTotal),
            unitCost: toStorageString(unitCost),
          },
        });
      }

      // --- The journal entry ------------------------------------------------
      const accountId = await resolveSystemAccounts(tx, companyId, [
        SYSTEM_ACCOUNT.CASH,
        SYSTEM_ACCOUNT.BANK,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
        SYSTEM_ACCOUNT.SALES,
        SYSTEM_ACCOUNT.GST_OUTPUT_CGST,
        SYSTEM_ACCOUNT.GST_OUTPUT_SGST,
        SYSTEM_ACCOUNT.GST_OUTPUT_IGST,
        SYSTEM_ACCOUNT.GST_OUTPUT_CESS,
        SYSTEM_ACCOUNT.ROUND_OFF,
        SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD,
        SYSTEM_ACCOUNT.INVENTORY,
      ]);

      const settlementKey = SETTLEMENT_ACCOUNT[input.paymentMode];
      const debitAccountId = settlementKey
        ? accountId(settlementKey)
        : accountId(SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE);

      const lines: DraftJournalLine[] = [
        {
          accountId: debitAccountId,
          debit: totals.totalAmount,
          narration: customer ? `Sale to ${customer.name}` : "Counter sale",
          ...(settlementKey
            ? {}
            : { partyType: PartyType.CUSTOMER, partyId: customer?.id ?? null }),
        },
        {
          accountId: accountId(SYSTEM_ACCOUNT.SALES),
          credit: totals.taxableAmount,
          narration: `Sales — ${invoiceNumber}`,
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
          lines.push({ accountId: accountId(key), credit: amount });
        }
      }

      // Round-off can fall either way; a positive figure means the customer was
      // billed slightly more than the exact total, which is income.
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

      // Cost of sales rides in the same entry as the revenue that earned it, so
      // the invoice and the entry stay one-to-one and the margin is visible in
      // a single place.
      if (!isZero(costOfGoodsSold)) {
        lines.push(
          {
            accountId: accountId(SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD),
            debit: costOfGoodsSold,
            narration: "Cost of goods sold",
          },
          {
            accountId: accountId(SYSTEM_ACCOUNT.INVENTORY),
            credit: costOfGoodsSold,
            narration: "Stock issued",
          },
        );
      }

      const entry = await postJournalEntry(tx, {
        companyId,
        branchId,
        entryDate: invoiceDate,
        voucherType: VoucherType.SALES,
        narration: customer
          ? `Invoice ${invoiceNumber} — ${customer.name}`
          : `Invoice ${invoiceNumber} — counter sale`,
        referenceNo: invoiceNumber,
        sourceType: SALE_SOURCE,
        sourceId: sale.id,
        createdById: params.userId,
        lines,
      });

      await tx.sale.update({
        where: { id: sale.id },
        data: {
          journalEntryId: entry.id,
          costOfGoodsSold: toStorageString(costOfGoodsSold),
        },
      });

      // --- GST register -----------------------------------------------------
      await writeGstRows(tx, {
        companyId,
        direction: GstDirection.OUTWARD,
        documentType: "SALE",
        documentId: sale.id,
        documentNumber: invoiceNumber,
        documentDate: invoiceDate,
        supplyType,
        placeOfSupply,
        partyName: customer?.name ?? "Counter sale",
        partyGstin: customer?.gstin ?? null,
        lines: computed.map((entry_) => ({
          ...entry_.result,
          hsnCode: entry_.product.hsnCode,
          taxRateId: entry_.product.taxRateId,
        })),
        sign: 1,
      });

      await recordAuditLog(
        {
          action: SALE_AUDIT.POSTED,
          module: "Sales",
          companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          entityType: "Sale",
          entityId: sale.id,
          metadata: {
            invoiceNumber,
            total: toStorageString(totals.totalAmount),
            supplyType,
            paymentMode: input.paymentMode,
            entryNumber: entry.entryNumber,
            customer: customer?.name ?? null,
          },
        },
        tx,
      );

      return {
        id: sale.id,
        invoiceNumber,
        totalAmount: toStorageString(totals.totalAmount),
        supplyType,
        entryNumber: entry.entryNumber,
      };
    },
    { timeout: 30_000 },
  );
}

/**
 * Voids a posted invoice.
 *
 * Nothing is edited and nothing is deleted. The original invoice, its journal
 * entry and its stock movements all stay exactly as they were; a reversing
 * entry, a matching inward stock movement and a negative GST row are added
 * beside them. That is what makes the void auditable — someone reading the
 * books later can see both that the sale happened and that it was undone, and
 * by whom.
 */
export async function voidSale(params: {
  companyId: string;
  saleId: string;
  userId: string;
  actorEmail: string;
  reason: string;
}): Promise<{ entryNumber: string }> {
  return prisma.$transaction(
    async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: params.saleId, companyId: params.companyId },
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          status: true,
          branchId: true,
          paymentMode: true,
          supplyType: true,
          placeOfSupply: true,
          totalAmount: true,
          taxableAmount: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          cessAmount: true,
          roundOff: true,
          costOfGoodsSold: true,
          journalEntryId: true,
          customer: { select: { id: true, name: true, gstin: true } },
          items: {
            select: {
              productId: true,
              quantity: true,
              unitCost: true,
              hsnCode: true,
              taxRateId: true,
              taxableAmount: true,
              taxPercent: true,
              cgstAmount: true,
              sgstAmount: true,
              igstAmount: true,
              cessAmount: true,
              lineTotal: true,
              discountAmount: true,
              product: { select: { isStockTracked: true } },
            },
          },
        },
      });

      if (!sale) {
        throw new SaleError("That invoice could not be found.", "NOT_FOUND");
      }
      if (sale.status === DocumentStatus.VOIDED) {
        throw new SaleError(
          "This invoice has already been voided.",
          "ALREADY_VOIDED",
        );
      }
      if (sale.status !== DocumentStatus.POSTED) {
        throw new SaleError(
          "Only a posted invoice can be voided.",
          "NOT_POSTED",
        );
      }

      // The mirror of the guard in `createSalesReturn`, which refuses a return
      // against a voided invoice because "returning would reverse them twice".
      // The same is true the other way round and was not checked: a void
      // reverses the whole invoice — every unit of stock, the full revenue, the
      // full tax — so an invoice that has already had part of it credited back
      // gets that part reversed a second time. The books then hold stock the
      // shop never had, negative revenue against a cancelled sale, and a
      // credit note in the GST register for an invoice that no longer exists.
      const returns = await tx.salesReturn.findMany({
        where: { companyId: params.companyId, saleId: sale.id },
        select: { returnNumber: true },
        orderBy: { returnDate: "asc" },
      });
      if (returns.length > 0) {
        const numbers = returns.map((entry) => entry.returnNumber).join(", ");
        throw new SaleError(
          `${sale.invoiceNumber} has already been credited back in part by ${numbers}, so it cannot be voided — that would reverse the returned goods twice. Record a return for what is left of it instead.`,
          "ALREADY_RETURNED",
        );
      }

      const company = await tx.company.findUniqueOrThrow({
        where: { id: params.companyId },
        select: { inventoryMethod: true },
      });
      const method = company.inventoryMethod as InventoryMethod;

      // --- Put the stock back ---------------------------------------------
      for (const item of sale.items) {
        if (!item.product.isStockTracked) continue;
        await recordInward(tx, {
          companyId: params.companyId,
          productId: item.productId,
          branchId: sale.branchId,
          method,
          quantity: item.quantity,
          // Returned at the cost it left at, so the void nets the inventory
          // account back to exactly where it started.
          unitCost: item.unitCost,
          movementType: StockMovementType.ADJUSTMENT_IN,
          movementDate: sale.invoiceDate,
          sourceType: SALE_VOID_SOURCE,
          sourceId: sale.id,
          referenceNo: sale.invoiceNumber,
          notes: `Void of invoice ${sale.invoiceNumber}`,
          createdById: params.userId,
        });
      }

      // --- Reverse the journal entry ---------------------------------------
      const entryId = sale.journalEntryId;
      if (!entryId) {
        throw new SaleError(
          "This invoice has no journal entry to reverse, so it cannot be voided safely.",
          "NO_ENTRY",
        );
      }

      const reversal = await reversePostedEntry(tx, {
        companyId: params.companyId,
        entryId,
        branchId: sale.branchId,
        entryDate: sale.invoiceDate,
        voucherType: VoucherType.SALES,
        narration: `Void of invoice ${sale.invoiceNumber} — ${params.reason}`,
        referenceNo: sale.invoiceNumber,
        sourceType: SALE_VOID_SOURCE,
        sourceId: sale.id,
        createdById: params.userId,
      });

      // --- Reverse the GST register ----------------------------------------
      await writeGstRows(tx, {
        companyId: params.companyId,
        direction: GstDirection.OUTWARD,
        documentType: "SALE",
        documentId: sale.id,
        documentNumber: sale.invoiceNumber,
        documentDate: sale.invoiceDate,
        supplyType: sale.supplyType,
        placeOfSupply: sale.placeOfSupply,
        partyName: sale.customer?.name ?? "Counter sale",
        partyGstin: sale.customer?.gstin ?? null,
        lines: sale.items.map((item) => ({
          grossAmount: money(item.taxableAmount),
          discountAmount: money(item.discountAmount),
          taxableAmount: money(item.taxableAmount),
          taxPercent: money(item.taxPercent),
          cgstAmount: money(item.cgstAmount),
          sgstAmount: money(item.sgstAmount),
          igstAmount: money(item.igstAmount),
          cessAmount: money(item.cessAmount),
          lineTotal: money(item.lineTotal),
          hsnCode: item.hsnCode,
          taxRateId: item.taxRateId,
        })),
        sign: -1,
      });

      // --- Release what was received against it ----------------------------
      //
      // The money stays received. Voiding says the sale should never have been
      // billed, not that the cash never arrived, so the receipt is untouched
      // and the customer simply ends up in credit — which the ledger works out
      // on its own, the reversal and the receipt both crediting receivables
      // until the control account sits at minus what was paid.
      //
      // The allocation rows are the part that has to be let go. Left behind,
      // they claim the receipt against an invoice that no longer exists, and
      // `allocated` is a sum over them — so the receipt reports itself fully
      // applied while the ledger says the shop is holding the customer's
      // money. The two disagree, and because `allocated` is what decides how
      // much of a receipt is still available, that credit can never be put
      // against the customer's next invoice. Real money, invisible.
      //
      // `paidAmount` below is zeroed for the same reason and always was; this
      // is the other half of it.
      const released = await tx.receiptAllocation.deleteMany({
        where: { saleId: sale.id },
      });

      await tx.sale.update({
        where: { id: sale.id },
        data: {
          status: DocumentStatus.VOIDED,
          voidedAt: new Date(),
          voidReason: params.reason,
          paidAmount: "0",
        },
      });

      await recordAuditLog(
        {
          action: SALE_AUDIT.VOIDED,
          module: "Sales",
          companyId: params.companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          entityType: "Sale",
          entityId: sale.id,
          metadata: {
            invoiceNumber: sale.invoiceNumber,
            total: toStorageString(sale.totalAmount),
            reason: params.reason,
            reversalEntry: reversal.entryNumber,
            // So the credit left on the customer's account is traceable to
            // the void that created it.
            receiptsReleased: released.count,
          },
        },
        tx,
      );

      return { entryNumber: reversal.entryNumber };
    },
    { timeout: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const SALE_PAGE_SIZE = 25;

export type SaleRow = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  customerName: string;
  status: DocumentStatus;
  paymentMode: PaymentMode;
  supplyType: SupplyType;
  taxableAmount: string;
  taxAmount: string;
  totalAmount: string;
  isCredit: boolean;
  dueDate: string | null;
};

export type SaleListResult = {
  rows: SaleRow[];
  total: number;
  page: number;
  pageCount: number;
  /** Posted invoices only — a voided invoice is not turnover. */
  postedTotal: string;
  postedTaxable: string;
  postedTax: string;
  creditOutstanding: string;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export async function listSales(params: {
  companyId: string;
  query?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
}): Promise<SaleListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const dateFilter: Prisma.DateTimeFilter = {};
  if (params.from) dateFilter.gte = new Date(`${params.from}T00:00:00.000Z`);
  if (params.to) dateFilter.lte = new Date(`${params.to}T00:00:00.000Z`);

  const where: Prisma.SaleWhereInput = {
    companyId: params.companyId,
    ...(params.status && params.status !== "ALL"
      ? { status: params.status as DocumentStatus }
      : {}),
    ...(Object.keys(dateFilter).length > 0 ? { invoiceDate: dateFilter } : {}),
    ...(query.length >= 1
      ? {
          OR: [
            {
              invoiceNumber: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              customer: {
                name: { contains: query, mode: Prisma.QueryMode.insensitive },
              },
            },
          ],
        }
      : {}),
  };

  const [total, sales, postedTotals, outstanding] = await Promise.all([
    prisma.sale.count({ where }),
    prisma.sale.findMany({
      where,
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        dueDate: true,
        status: true,
        paymentMode: true,
        supplyType: true,
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
        totalAmount: true,
        customer: { select: { name: true } },
      },
      orderBy: [{ invoiceDate: "desc" }, { invoiceNumber: "desc" }],
      skip: (page - 1) * SALE_PAGE_SIZE,
      take: SALE_PAGE_SIZE,
    }),
    prisma.sale.aggregate({
      where: { ...where, status: DocumentStatus.POSTED },
      _sum: {
        totalAmount: true,
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
      },
    }),
    // The documents themselves rather than a sum of them, because what each
    // one still owes needs the credit notes against it and those are per
    // document. Three small columns; the same rows the ageing already reads.
    prisma.sale.findMany({
      where: {
        companyId: params.companyId,
        status: DocumentStatus.POSTED,
        paymentMode: "CREDIT",
      },
      select: {
        id: true,
        customerId: true,
        invoiceDate: true,
        dueDate: true,
        totalAmount: true,
        paidAmount: true,
      },
    }),
  ]);

  // A credit note settles an invoice exactly as a receipt does. This figure
  // used to be total less receipted, which is what "settled" meant before
  // returns existed — so the headline on the sales page went on claiming money
  // the ageing report, the reminder and the receipt form had all stopped
  // asking for. `settledByNotes` is the definition those three share.
  const creditedByNotes = await settledByNotes(prisma, {
    companyId: params.companyId,
    documentIds: outstanding.map((sale) => sale.id),
    side: "RECEIVABLE",
  });
  // And money the customer has sent against no invoice in particular settles
  // it just as surely. That is not a fact about any one document, so it cannot
  // be read off them: the receipt credits the control account and leaves every
  // `paidAmount` where it was. Without this the headline went on claiming
  // money already in the bank — the same fault as the credit note above, from
  // the other side, and against the same test: this figure has to equal the
  // receivable account or the page has drifted from the books.
  const openCredit = outstanding
    .map((sale) => ({
      partyId: sale.customerId ?? "",
      dueDate: sale.dueDate ?? sale.invoiceDate,
      outstanding: subtract(
        sale.totalAmount,
        add(sale.paidAmount, creditedByNotes.get(sale.id) ?? money(0)),
      ),
    }))
    .filter((row) => compare(row.outstanding, 0) > 0);

  const documented = new Map<string, ReturnType<typeof money>>();
  for (const row of openCredit) {
    if (!row.partyId) continue;
    documented.set(
      row.partyId,
      add(documented.get(row.partyId) ?? money(0), row.outstanding),
    );
  }
  const held = await unappliedCreditByParty({
    companyId: params.companyId,
    side: "RECEIVABLE",
    documented,
  });

  const creditOutstanding = add(
    ...afterUnappliedCredit(openCredit, held).map((row) => row.outstanding),
  );

  return {
    rows: sales.map((sale) => ({
      id: sale.id,
      invoiceNumber: sale.invoiceNumber,
      invoiceDate: isoDay(sale.invoiceDate),
      customerName: sale.customer?.name ?? "Counter sale",
      status: sale.status,
      paymentMode: sale.paymentMode,
      supplyType: sale.supplyType,
      taxableAmount: toStorageString(sale.taxableAmount),
      taxAmount: toStorageString(
        add(sale.cgstAmount, sale.sgstAmount, sale.igstAmount, sale.cessAmount),
      ),
      totalAmount: toStorageString(sale.totalAmount),
      isCredit: sale.paymentMode === "CREDIT",
      dueDate: sale.dueDate ? isoDay(sale.dueDate) : null,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / SALE_PAGE_SIZE)),
    postedTotal: toStorageString(postedTotals._sum.totalAmount ?? 0),
    postedTaxable: toStorageString(postedTotals._sum.taxableAmount ?? 0),
    postedTax: toStorageString(
      add(
        postedTotals._sum.cgstAmount ?? 0,
        postedTotals._sum.sgstAmount ?? 0,
        postedTotals._sum.igstAmount ?? 0,
        postedTotals._sum.cessAmount ?? 0,
      ),
    ),
    creditOutstanding: toStorageString(creditOutstanding),
  };
}

export type SaleDetail = Awaited<ReturnType<typeof getSale>>;

export async function getSale(params: { companyId: string; saleId: string }) {
  const sale = await prisma.sale.findFirst({
    where: { id: params.saleId, companyId: params.companyId },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      dueDate: true,
      status: true,
      paymentMode: true,
      supplyType: true,
      placeOfSupply: true,
      subTotal: true,
      discountAmount: true,
      taxableAmount: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      cessAmount: true,
      roundOff: true,
      totalAmount: true,
      paidAmount: true,
      costOfGoodsSold: true,
      notes: true,
      voidedAt: true,
      voidReason: true,
      postedAt: true,
      journalEntryId: true,
      customer: {
        select: {
          id: true,
          name: true,
          gstin: true,
          city: true,
          stateCode: true,
        },
      },
      branch: { select: { name: true } },
      items: {
        select: {
          lineNumber: true,
          description: true,
          hsnCode: true,
          quantity: true,
          rate: true,
          discountPercent: true,
          discountAmount: true,
          taxableAmount: true,
          taxPercent: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          cessAmount: true,
          lineTotal: true,
          unitCost: true,
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              unit: { select: { code: true } },
            },
          },
        },
        orderBy: { lineNumber: "asc" },
      },
    },
  });

  if (!sale) {
    throw new MasterDataError("That invoice could not be found.", "NOT_FOUND");
  }

  const entry = sale.journalEntryId
    ? await prisma.journalEntry.findFirst({
        where: { id: sale.journalEntryId, companyId: params.companyId },
        select: {
          entryNumber: true,
          status: true,
          totalDebit: true,
          lines: {
            select: {
              lineNumber: true,
              debit: true,
              credit: true,
              narration: true,
              account: { select: { code: true, name: true } },
            },
            orderBy: { lineNumber: "asc" },
          },
        },
      })
    : null;

  return { sale, entry };
}
