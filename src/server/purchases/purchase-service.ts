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
  chargesTax,
  computeLine,
  resolveSupplyType,
  totalLines,
  type SupplyType,
} from "@/lib/tax/gst";
import {
  type Decimal,
  add,
  divide,
  isZero,
  money,
  toStorageString,
} from "@/lib/money";
import type { PurchaseInput } from "@/lib/validation/purchases";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { recordAuditLog } from "@/server/audit/audit-log";
import { resolveSystemAccounts } from "@/server/documents/accounts";
import { writeGstRows } from "@/server/documents/gst-register";
import { reversePostedEntry } from "@/server/documents/reversal";
import { recordInward, recordOutward } from "@/server/inventory/stock-service";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";
import { MasterDataError } from "@/server/master-data/errors";

/**
 * Supplier bills.
 *
 * The mirror of a sales invoice, with two differences that are not cosmetic.
 *
 * **Who is selling.** On a purchase the *supplier* is the seller, so whether
 * the bill carries GST depends on their registration, and whether it is CGST +
 * SGST or IGST depends on their state against ours — not the other way round.
 *
 * **Whether the tax is recoverable.** A registered business under the regular
 * scheme sets input tax against the tax it collects, so the GST on a bill is an
 * asset. A composition dealer or an unregistered business cannot: for them the
 * tax is simply part of what the goods cost, and burying it in an input account
 * it can never claim would overstate assets and understate cost of sales for as
 * long as the business exists.
 */

export const PURCHASE_AUDIT = {
  POSTED: "purchase.posted",
  VOIDED: "purchase.voided",
} as const;

export const PURCHASE_SOURCE = "PURCHASE";
export const PURCHASE_VOID_SOURCE = "PURCHASE_VOID";

export class PurchaseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "PurchaseError";
  }
}

/** Where the money comes from when a bill is settled on the spot. */
const SETTLEMENT_ACCOUNT: Record<PaymentMode, string | null> = {
  CASH: SYSTEM_ACCOUNT.CASH,
  BANK: SYSTEM_ACCOUNT.BANK,
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
      throw new PurchaseError(
        `${product.name} is archived. Restore it before buying it.`,
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
      throw new PurchaseError(
        "A product on this bill could not be found.",
        "NOT_FOUND",
      );
    }
  }

  return map;
}

export type PostedPurchase = {
  id: string;
  billNumber: string;
  totalAmount: string;
  supplyType: SupplyType;
  itcEligible: boolean;
  entryNumber: string;
};

export async function createPurchase(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  branchId: string | null;
  input: PurchaseInput;
}): Promise<PostedPurchase> {
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
      const billDate = new Date(`${input.billDate}T00:00:00.000Z`);

      const branchId =
        params.branchId ??
        (
          await tx.branch.findFirst({
            where: { companyId, isPrimary: true },
            select: { id: true },
          })
        )?.id ??
        null;

      // --- Supplier ---------------------------------------------------------
      const supplier = await tx.supplier.findFirst({
        where: { id: input.supplierId, companyId },
        select: {
          id: true,
          name: true,
          gstin: true,
          stateCode: true,
          creditDays: true,
          archivedAt: true,
        },
      });

      if (!supplier) {
        throw new PurchaseError(
          "That supplier could not be found.",
          "NOT_FOUND",
          "supplierId",
        );
      }
      if (supplier.archivedAt) {
        throw new PurchaseError(
          `${supplier.name} is archived. Restore them before recording their bills.`,
          "SUPPLIER_ARCHIVED",
          "supplierId",
        );
      }

      // Paying the same bill twice is one of the easiest mistakes to make and
      // one of the hardest to notice afterwards.
      if (input.supplierBillNo) {
        const duplicate = await tx.purchase.findFirst({
          where: {
            companyId,
            supplierId: supplier.id,
            supplierBillNo: input.supplierBillNo,
            status: { not: DocumentStatus.VOIDED },
          },
          select: { billNumber: true },
        });
        if (duplicate) {
          throw new PurchaseError(
            `${supplier.name}'s bill ${input.supplierBillNo} is already recorded as ${duplicate.billNumber}.`,
            "DUPLICATE_BILL",
            "supplierBillNo",
          );
        }
      }

      // --- Tax treatment ----------------------------------------------------
      // The supplier is the seller here, so their registration and their state
      // are what decide the treatment. A supplier with no GSTIN charges none.
      const supplierRegistration = supplier.gstin ? "REGULAR" : "UNREGISTERED";
      const supplyType = resolveSupplyType({
        registration: supplierRegistration,
        sellerStateCode: supplier.stateCode ?? company.stateCode,
        placeOfSupplyStateCode: company.stateCode,
      });

      // Only a regular-scheme buyer can set input tax against output tax. For
      // anyone else it is part of the cost of the goods.
      const canClaimCredit =
        company.gstRegistration === "REGULAR" && chargesTax(supplyType);
      const itcEligible = canClaimCredit && input.claimInputCredit;

      const products = await resolveProducts(
        tx,
        companyId,
        input.lines.map((line) => line.productId),
      );

      const computed = input.lines.map((line) => {
        const product = products.get(line.productId);
        if (!product) {
          throw new PurchaseError(
            "A product on this bill could not be found.",
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
        throw new PurchaseError(
          "This bill comes to nothing. Check the quantities and rates.",
          "ZERO_TOTAL",
        );
      }

      // --- Document number --------------------------------------------------
      const fiscalYear = await ensureFiscalYearFor(tx, {
        companyId,
        date: billDate,
      });

      const billNumber = await allocateDocumentNumber(tx, {
        companyId,
        key: "PURCHASE",
        fiscalYearId: fiscalYear.id,
      });

      const settledNow = input.paymentMode !== "CREDIT";
      const dueDate =
        input.paymentMode === "CREDIT"
          ? new Date(
              billDate.getTime() + supplier.creditDays * 24 * 60 * 60 * 1000,
            )
          : null;

      const purchase = await tx.purchase.create({
        data: {
          companyId,
          branchId,
          supplierId: supplier.id,
          billNumber,
          supplierBillNo: input.supplierBillNo || null,
          billDate,
          dueDate,
          creditDays: supplier.creditDays,
          status: DocumentStatus.POSTED,
          paymentMode: input.paymentMode,
          supplyType,
          itcEligible,
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
        select: { id: true, billNumber: true },
      });

      // --- Stock in, at landed cost -----------------------------------------
      let stockValue = money(0);
      let expenseValue = money(0);

      for (const [index, entry] of computed.entries()) {
        // The cost that goes into inventory is what the goods actually cost the
        // business. Recoverable tax is not a cost — it comes back. Tax that
        // cannot be claimed is, so it is landed onto the stock.
        const lineTax = add(
          entry.result.cgstAmount,
          entry.result.sgstAmount,
          entry.result.igstAmount,
          entry.result.cessAmount,
        );
        const lineCost = itcEligible
          ? entry.result.taxableAmount
          : add(entry.result.taxableAmount, lineTax);

        const unitCost = divide(lineCost, entry.line.quantity);

        if (entry.product.isStockTracked) {
          await recordInward(tx, {
            companyId,
            productId: entry.product.id,
            branchId,
            method,
            quantity: entry.line.quantity,
            unitCost,
            movementType: StockMovementType.PURCHASE,
            movementDate: billDate,
            sourceType: PURCHASE_SOURCE,
            sourceId: purchase.id,
            referenceNo: billNumber,
            createdById: params.userId,
          });
          stockValue = add(stockValue, lineCost);
        } else {
          // Nothing to hold in stock — freight, packing, a service on the same
          // bill. It is a cost of trading the moment it is incurred.
          expenseValue = add(expenseValue, lineCost);
        }

        await tx.purchaseItem.create({
          data: {
            companyId,
            purchaseId: purchase.id,
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
        SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
        SYSTEM_ACCOUNT.INVENTORY,
        SYSTEM_ACCOUNT.DIRECT_EXPENSES,
        SYSTEM_ACCOUNT.GST_INPUT_CGST,
        SYSTEM_ACCOUNT.GST_INPUT_SGST,
        SYSTEM_ACCOUNT.GST_INPUT_IGST,
        SYSTEM_ACCOUNT.GST_INPUT_CESS,
        SYSTEM_ACCOUNT.ROUND_OFF,
      ]);

      const lines: DraftJournalLine[] = [];

      if (!isZero(stockValue)) {
        lines.push({
          accountId: accountId(SYSTEM_ACCOUNT.INVENTORY),
          debit: stockValue,
          narration: `Stock received — ${billNumber}`,
        });
      }
      if (!isZero(expenseValue)) {
        lines.push({
          accountId: accountId(SYSTEM_ACCOUNT.DIRECT_EXPENSES),
          debit: expenseValue,
          narration: `Charges on ${billNumber}`,
        });
      }

      // Input tax is an asset only when it can actually be set off. Otherwise
      // it has already been landed onto the cost above and must not appear here
      // as well, or the bill would be counted twice.
      if (itcEligible) {
        const taxLines: Array<[string, Decimal]> = [
          [SYSTEM_ACCOUNT.GST_INPUT_CGST, totals.cgstAmount],
          [SYSTEM_ACCOUNT.GST_INPUT_SGST, totals.sgstAmount],
          [SYSTEM_ACCOUNT.GST_INPUT_IGST, totals.igstAmount],
          [SYSTEM_ACCOUNT.GST_INPUT_CESS, totals.cessAmount],
        ];
        for (const [key, amount] of taxLines) {
          if (!isZero(amount)) {
            lines.push({ accountId: accountId(key), debit: amount });
          }
        }
      }

      // A positive round-off means the supplier billed slightly more than the
      // exact figure, which is a cost.
      if (!isZero(totals.roundOff)) {
        lines.push(
          totals.roundOff.greaterThan(0)
            ? {
                accountId: accountId(SYSTEM_ACCOUNT.ROUND_OFF),
                debit: totals.roundOff,
              }
            : {
                accountId: accountId(SYSTEM_ACCOUNT.ROUND_OFF),
                credit: totals.roundOff.abs(),
              },
        );
      }

      const settlementKey = SETTLEMENT_ACCOUNT[input.paymentMode];
      lines.push({
        accountId: settlementKey
          ? accountId(settlementKey)
          : accountId(SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
        credit: totals.totalAmount,
        narration: `Bill from ${supplier.name}`,
        ...(settlementKey
          ? {}
          : { partyType: PartyType.SUPPLIER, partyId: supplier.id }),
      });

      const entry = await postJournalEntry(tx, {
        companyId,
        branchId,
        entryDate: billDate,
        voucherType: VoucherType.PURCHASE,
        narration: `Bill ${billNumber} — ${supplier.name}`,
        referenceNo: input.supplierBillNo || billNumber,
        sourceType: PURCHASE_SOURCE,
        sourceId: purchase.id,
        createdById: params.userId,
        lines,
      });

      await tx.purchase.update({
        where: { id: purchase.id },
        data: { journalEntryId: entry.id },
      });

      // --- GST register -----------------------------------------------------
      await writeGstRows(tx, {
        companyId,
        direction: GstDirection.INWARD,
        documentType: "PURCHASE",
        documentId: purchase.id,
        documentNumber: billNumber,
        documentDate: billDate,
        supplyType,
        placeOfSupply: company.stateCode,
        partyName: supplier.name,
        partyGstin: supplier.gstin,
        itcEligible,
        lines: computed.map((item) => ({
          ...item.result,
          hsnCode: item.product.hsnCode,
          taxRateId: item.product.taxRateId,
        })),
        sign: 1,
      });

      await recordAuditLog(
        {
          action: PURCHASE_AUDIT.POSTED,
          module: "Purchases",
          companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          entityType: "Purchase",
          entityId: purchase.id,
          metadata: {
            billNumber,
            supplierBillNo: input.supplierBillNo || null,
            supplier: supplier.name,
            total: toStorageString(totals.totalAmount),
            supplyType,
            itcEligible,
            entryNumber: entry.entryNumber,
          },
        },
        tx,
      );

      return {
        id: purchase.id,
        billNumber,
        totalAmount: toStorageString(totals.totalAmount),
        supplyType,
        itcEligible,
        entryNumber: entry.entryNumber,
      };
    },
    { timeout: 30_000 },
  );
}

/**
 * Voids a posted bill.
 *
 * The stock has to come back out, and that is where a purchase differs from a
 * sale: some of what came in may already have been sold. Taking it out anyway
 * would drive the position negative and fabricate a cost, so the void is
 * refused with the figures — and the honest fix is a purchase return, which
 * records that the goods went back to the supplier.
 */
export async function voidPurchase(params: {
  companyId: string;
  purchaseId: string;
  userId: string;
  actorEmail: string;
  reason: string;
}): Promise<{ entryNumber: string }> {
  return prisma.$transaction(
    async (tx) => {
      const purchase = await tx.purchase.findFirst({
        where: { id: params.purchaseId, companyId: params.companyId },
        select: {
          id: true,
          billNumber: true,
          billDate: true,
          status: true,
          branchId: true,
          supplyType: true,
          totalAmount: true,
          itcEligible: true,
          journalEntryId: true,
          supplier: { select: { id: true, name: true, gstin: true } },
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
              product: {
                select: {
                  name: true,
                  isStockTracked: true,
                  unit: { select: { code: true } },
                },
              },
            },
          },
        },
      });

      if (!purchase) {
        throw new PurchaseError("That bill could not be found.", "NOT_FOUND");
      }
      if (purchase.status === DocumentStatus.VOIDED) {
        throw new PurchaseError(
          "This bill has already been voided.",
          "ALREADY_VOIDED",
        );
      }
      if (purchase.status !== DocumentStatus.POSTED) {
        throw new PurchaseError(
          "Only a posted bill can be voided.",
          "NOT_POSTED",
        );
      }

      // As on the sales side: a void reverses the whole bill, so a bill that
      // has already had part of it sent back to the supplier gets that part
      // reversed twice. `STOCK_ALREADY_SOLD` below catches some of these by
      // accident — taking the stock back out fails when there is not enough
      // left — but only when the shop happens to be short. A bill returned in
      // part and restocked from elsewhere passes that check and corrupts the
      // books quietly, which is the worse of the two outcomes.
      const returns = await tx.purchaseReturn.findMany({
        where: { companyId: params.companyId, purchaseId: purchase.id },
        select: { returnNumber: true },
        orderBy: { returnDate: "asc" },
      });
      if (returns.length > 0) {
        const numbers = returns.map((entry) => entry.returnNumber).join(", ");
        throw new PurchaseError(
          `${purchase.billNumber} has already been returned in part by ${numbers}, so it cannot be voided — that would reverse the returned goods twice. Record a return for what is left of it instead.`,
          "ALREADY_RETURNED",
        );
      }

      const entryId = purchase.journalEntryId;
      if (!entryId) {
        throw new PurchaseError(
          "This bill has no journal entry to reverse, so it cannot be voided safely.",
          "NO_ENTRY",
        );
      }

      const company = await tx.company.findUniqueOrThrow({
        where: { id: params.companyId },
        select: { inventoryMethod: true, stateCode: true },
      });
      const method = company.inventoryMethod as InventoryMethod;

      // --- Take the stock back out ------------------------------------------
      for (const item of purchase.items) {
        if (!item.product.isStockTracked) continue;
        try {
          await recordOutward(tx, {
            companyId: params.companyId,
            productId: item.productId,
            branchId: purchase.branchId,
            method,
            quantity: item.quantity,
            movementType: StockMovementType.ADJUSTMENT_OUT,
            movementDate: purchase.billDate,
            sourceType: PURCHASE_VOID_SOURCE,
            sourceId: purchase.id,
            referenceNo: purchase.billNumber,
            notes: `Void of bill ${purchase.billNumber}`,
            createdById: params.userId,
          });
        } catch (error) {
          if (error instanceof InsufficientStockError) {
            throw new PurchaseError(
              `${item.product.name} cannot be taken back: only ${error.available.toString()} ${item.product.unit.code} are left of the ${error.requested.toString()} this bill brought in. Some of it has been sold, so record a purchase return instead of voiding.`,
              "STOCK_ALREADY_SOLD",
            );
          }
          throw error;
        }
      }

      const reversal = await reversePostedEntry(tx, {
        companyId: params.companyId,
        entryId,
        branchId: purchase.branchId,
        entryDate: purchase.billDate,
        voucherType: VoucherType.PURCHASE,
        narration: `Void of bill ${purchase.billNumber} — ${params.reason}`,
        referenceNo: purchase.billNumber,
        sourceType: PURCHASE_VOID_SOURCE,
        sourceId: purchase.id,
        createdById: params.userId,
      });

      await writeGstRows(tx, {
        companyId: params.companyId,
        direction: GstDirection.INWARD,
        documentType: "PURCHASE",
        documentId: purchase.id,
        documentNumber: purchase.billNumber,
        documentDate: purchase.billDate,
        supplyType: purchase.supplyType,
        placeOfSupply: company.stateCode,
        partyName: purchase.supplier?.name ?? "Supplier",
        partyGstin: purchase.supplier?.gstin ?? null,
        itcEligible: purchase.itcEligible,
        lines: purchase.items.map((item) => ({
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

      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          status: DocumentStatus.VOIDED,
          voidedAt: new Date(),
          voidReason: params.reason,
          paidAmount: "0",
        },
      });

      await recordAuditLog(
        {
          action: PURCHASE_AUDIT.VOIDED,
          module: "Purchases",
          companyId: params.companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          entityType: "Purchase",
          entityId: purchase.id,
          metadata: {
            billNumber: purchase.billNumber,
            total: toStorageString(purchase.totalAmount),
            reason: params.reason,
            reversalEntry: reversal.entryNumber,
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

export const PURCHASE_PAGE_SIZE = 25;

export type PurchaseRow = {
  id: string;
  billNumber: string;
  supplierBillNo: string | null;
  billDate: string;
  supplierName: string;
  status: DocumentStatus;
  paymentMode: PaymentMode;
  supplyType: SupplyType;
  taxableAmount: string;
  taxAmount: string;
  totalAmount: string;
  itcEligible: boolean;
  isCredit: boolean;
  dueDate: string | null;
};

export type PurchaseListResult = {
  rows: PurchaseRow[];
  total: number;
  page: number;
  pageCount: number;
  postedTotal: string;
  /** Input tax credit accumulated from posted, eligible bills. */
  inputCredit: string;
  payablesOutstanding: string;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export async function listPurchases(params: {
  companyId: string;
  query?: string;
  status?: string;
  /** Inclusive bill-date window, as `listSales` already accepted. */
  from?: string;
  to?: string;
  page?: number;
}): Promise<PurchaseListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const dateFilter: Prisma.DateTimeFilter = {};
  if (params.from) dateFilter.gte = new Date(`${params.from}T00:00:00.000Z`);
  if (params.to) dateFilter.lte = new Date(`${params.to}T00:00:00.000Z`);

  const where: Prisma.PurchaseWhereInput = {
    companyId: params.companyId,
    ...(params.status && params.status !== "ALL"
      ? { status: params.status as DocumentStatus }
      : {}),
    ...(Object.keys(dateFilter).length > 0 ? { billDate: dateFilter } : {}),
    ...(query.length >= 1
      ? {
          OR: [
            {
              billNumber: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              supplierBillNo: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              supplier: {
                name: { contains: query, mode: Prisma.QueryMode.insensitive },
              },
            },
          ],
        }
      : {}),
  };

  const [total, purchases, postedTotals, credit, outstanding] =
    await Promise.all([
      prisma.purchase.count({ where }),
      prisma.purchase.findMany({
        where,
        select: {
          id: true,
          billNumber: true,
          supplierBillNo: true,
          billDate: true,
          dueDate: true,
          status: true,
          paymentMode: true,
          supplyType: true,
          itcEligible: true,
          taxableAmount: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          cessAmount: true,
          totalAmount: true,
          supplier: { select: { name: true } },
        },
        orderBy: [{ billDate: "desc" }, { billNumber: "desc" }],
        skip: (page - 1) * PURCHASE_PAGE_SIZE,
        take: PURCHASE_PAGE_SIZE,
      }),
      prisma.purchase.aggregate({
        where: { ...where, status: DocumentStatus.POSTED },
        _sum: { totalAmount: true },
      }),
      prisma.purchase.aggregate({
        where: {
          companyId: params.companyId,
          status: DocumentStatus.POSTED,
          itcEligible: true,
        },
        _sum: {
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          cessAmount: true,
        },
      }),
      prisma.purchase.aggregate({
        where: {
          companyId: params.companyId,
          status: DocumentStatus.POSTED,
          paymentMode: "CREDIT",
        },
        _sum: { totalAmount: true, paidAmount: true },
      }),
    ]);

  return {
    rows: purchases.map((purchase) => ({
      id: purchase.id,
      billNumber: purchase.billNumber,
      supplierBillNo: purchase.supplierBillNo,
      billDate: isoDay(purchase.billDate),
      supplierName: purchase.supplier?.name ?? "—",
      status: purchase.status,
      paymentMode: purchase.paymentMode,
      supplyType: purchase.supplyType,
      itcEligible: purchase.itcEligible,
      taxableAmount: toStorageString(purchase.taxableAmount),
      taxAmount: toStorageString(
        add(
          purchase.cgstAmount,
          purchase.sgstAmount,
          purchase.igstAmount,
          purchase.cessAmount,
        ),
      ),
      totalAmount: toStorageString(purchase.totalAmount),
      isCredit: purchase.paymentMode === "CREDIT",
      dueDate: purchase.dueDate ? isoDay(purchase.dueDate) : null,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PURCHASE_PAGE_SIZE)),
    postedTotal: toStorageString(postedTotals._sum.totalAmount ?? 0),
    inputCredit: toStorageString(
      add(
        credit._sum.cgstAmount ?? 0,
        credit._sum.sgstAmount ?? 0,
        credit._sum.igstAmount ?? 0,
        credit._sum.cessAmount ?? 0,
      ),
    ),
    payablesOutstanding: toStorageString(
      money(outstanding._sum.totalAmount ?? 0).minus(
        money(outstanding._sum.paidAmount ?? 0),
      ),
    ),
  };
}

export async function getPurchase(params: {
  companyId: string;
  purchaseId: string;
}) {
  const purchase = await prisma.purchase.findFirst({
    where: { id: params.purchaseId, companyId: params.companyId },
    select: {
      id: true,
      billNumber: true,
      supplierBillNo: true,
      billDate: true,
      dueDate: true,
      status: true,
      paymentMode: true,
      supplyType: true,
      itcEligible: true,
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
      notes: true,
      voidedAt: true,
      voidReason: true,
      journalEntryId: true,
      supplier: {
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

  if (!purchase) {
    throw new MasterDataError("That bill could not be found.", "NOT_FOUND");
  }

  const entry = purchase.journalEntryId
    ? await prisma.journalEntry.findFirst({
        where: { id: purchase.journalEntryId, companyId: params.companyId },
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

  return { purchase, entry };
}
