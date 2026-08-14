import "server-only";
import {
  DocumentStatus,
  GstDirection,
  PartyType,
  Prisma,
  VoucherType,
  type PaymentMode,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { DraftJournalLine } from "@/lib/accounting/double-entry";
import {
  chargesTax,
  computeLine,
  resolveSupplyType,
  type SupplyType,
} from "@/lib/tax/gst";
import { type Decimal, add, isZero, money, toStorageString } from "@/lib/money";
import type { ExpenseInput } from "@/lib/validation/expenses";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { recordAuditLog } from "@/server/audit/audit-log";
import { resolveSystemAccounts } from "@/server/documents/accounts";
import { writeGstRows } from "@/server/documents/gst-register";
import { reversePostedEntry } from "@/server/documents/reversal";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import { MasterDataError } from "@/server/master-data/errors";

/**
 * Expenses.
 *
 * Simpler than a bill — one amount, one category — and it carries the two
 * judgements that decide whether a business's profit figure means anything.
 *
 * **Capital or revenue.** A fridge bought for the shop is not a cost of this
 * month; it is an asset that wears out over years. Recording it as an expense
 * understates profit now and overstates it every month afterwards, and no
 * report built on those figures can be right. Capital items go to fixed assets
 * and join the asset register, ready to be depreciated.
 *
 * **Claimable or not.** GST on an expense is recoverable only for a business
 * registered under the regular scheme. For anyone else it is part of the cost,
 * exactly as on a purchase bill.
 */

export const EXPENSE_AUDIT = {
  POSTED: "expense.posted",
  VOIDED: "expense.voided",
} as const;

export const EXPENSE_SOURCE = "EXPENSE";
export const EXPENSE_VOID_SOURCE = "EXPENSE_VOID";

export class ExpenseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ExpenseError";
  }
}

/** Where the money leaves from when an expense is settled on the spot. */
const SETTLEMENT_ACCOUNT: Record<PaymentMode, string | null> = {
  CASH: SYSTEM_ACCOUNT.CASH,
  BANK: SYSTEM_ACCOUNT.BANK,
  UPI: SYSTEM_ACCOUNT.BANK,
  CARD: SYSTEM_ACCOUNT.BANK,
  CHEQUE: SYSTEM_ACCOUNT.BANK,
  CREDIT: null,
  OTHER: null,
};

export type PostedExpense = {
  id: string;
  voucherNumber: string;
  totalAmount: string;
  itcEligible: boolean;
  isCapitalExpenditure: boolean;
  assetCode: string | null;
  entryNumber: string;
};

export async function createExpense(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  branchId: string | null;
  input: ExpenseInput;
}): Promise<PostedExpense> {
  const { companyId, input } = params;

  return prisma.$transaction(
    async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { stateCode: true, gstRegistration: true },
      });

      const expenseDate = new Date(`${input.expenseDate}T00:00:00.000Z`);

      const branchId =
        params.branchId ??
        (
          await tx.branch.findFirst({
            where: { companyId, isPrimary: true },
            select: { id: true },
          })
        )?.id ??
        null;

      // --- Category ---------------------------------------------------------
      const category = await tx.expenseCategory.findFirst({
        where: { id: input.categoryId, companyId },
        select: { id: true, name: true, accountId: true, isActive: true },
      });
      if (!category) {
        throw new ExpenseError(
          "That expense category could not be found.",
          "NOT_FOUND",
          "categoryId",
        );
      }
      if (!category.isActive) {
        throw new ExpenseError(
          `The ${category.name} category is no longer in use.`,
          "CATEGORY_INACTIVE",
          "categoryId",
        );
      }

      // --- Payee ------------------------------------------------------------
      const supplier = input.supplierId
        ? await tx.supplier.findFirst({
            where: { id: input.supplierId, companyId },
            select: {
              id: true,
              name: true,
              gstin: true,
              stateCode: true,
              archivedAt: true,
            },
          })
        : null;

      if (input.supplierId && !supplier) {
        throw new ExpenseError(
          "That supplier could not be found.",
          "NOT_FOUND",
          "supplierId",
        );
      }
      if (supplier?.archivedAt) {
        throw new ExpenseError(
          `${supplier.name} is archived. Restore them before recording expenses against them.`,
          "SUPPLIER_ARCHIVED",
          "supplierId",
        );
      }

      const payeeName = supplier?.name ?? input.payeeName ?? null;

      // --- Tax --------------------------------------------------------------
      // The payee is the seller, so where they are decides the split. A payee
      // we have not set up as a supplier is assumed to be local, which is what
      // a shop receipt almost always is.
      const supplyType: SupplyType =
        input.taxPercent > 0
          ? resolveSupplyType({
              registration: "REGULAR",
              sellerStateCode: supplier?.stateCode ?? company.stateCode,
              placeOfSupplyStateCode: company.stateCode,
            })
          : "NON_GST";

      const computed = computeLine(
        {
          quantity: 1,
          rate: input.amount,
          taxPercent: input.taxPercent,
          priceIncludesTax: input.amountIncludesTax,
        },
        supplyType,
      );

      const totalTax = add(
        computed.cgstAmount,
        computed.sgstAmount,
        computed.igstAmount,
      );

      const canClaimCredit =
        company.gstRegistration === "REGULAR" && chargesTax(supplyType);
      const itcEligible =
        canClaimCredit && input.claimInputCredit && !totalTax.isZero();

      // What the expense — or the asset — is actually worth to the business.
      // Recoverable tax is not part of it; tax that cannot be claimed is.
      const carriedCost = itcEligible
        ? computed.taxableAmount
        : add(computed.taxableAmount, totalTax);

      // --- Document number --------------------------------------------------
      const fiscalYear = await tx.fiscalYear.findFirst({
        where: {
          companyId,
          startDate: { lte: expenseDate },
          endDate: { gte: expenseDate },
        },
        select: { id: true },
      });

      const voucherNumber = await allocateDocumentNumber(tx, {
        companyId,
        key: "EXPENSE",
        fiscalYearId: fiscalYear?.id ?? null,
      });

      const expense = await tx.expense.create({
        data: {
          companyId,
          branchId,
          categoryId: category.id,
          voucherNumber,
          expenseDate,
          status: DocumentStatus.POSTED,
          paymentMode: input.paymentMode,
          payeeName,
          partyType: supplier ? PartyType.SUPPLIER : null,
          partyId: supplier?.id ?? null,
          amount: toStorageString(computed.taxableAmount),
          taxableAmount: toStorageString(computed.taxableAmount),
          cgstAmount: toStorageString(computed.cgstAmount),
          sgstAmount: toStorageString(computed.sgstAmount),
          igstAmount: toStorageString(computed.igstAmount),
          totalAmount: toStorageString(computed.lineTotal),
          itcEligible,
          isCapitalExpenditure: input.isCapitalExpenditure,
          referenceNo: input.referenceNo || null,
          notes: input.notes || null,
          postedAt: new Date(),
          createdById: params.userId,
        },
        select: { id: true, voucherNumber: true },
      });

      // --- Where the cost lands ---------------------------------------------
      const accountId = await resolveSystemAccounts(tx, companyId, [
        SYSTEM_ACCOUNT.CASH,
        SYSTEM_ACCOUNT.BANK,
        SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
        SYSTEM_ACCOUNT.FIXED_ASSETS,
        SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
        SYSTEM_ACCOUNT.GST_INPUT_CGST,
        SYSTEM_ACCOUNT.GST_INPUT_SGST,
        SYSTEM_ACCOUNT.GST_INPUT_IGST,
      ]);

      let assetCode: string | null = null;
      let costAccountId: string;

      if (input.isCapitalExpenditure) {
        costAccountId = accountId(SYSTEM_ACCOUNT.FIXED_ASSETS);
        // Derived from the voucher rather than from its own series: voucher
        // numbers are already unique per company, and tying the two together
        // means the void can find the asset again by name instead of guessing
        // from a date and an amount.
        assetCode = `FA-${expense.voucherNumber}`;

        // An asset in the balance sheet with no entry in the register is an
        // asset nobody will ever depreciate.
        await tx.fixedAsset.create({
          data: {
            companyId,
            accountId: costAccountId,
            code: assetCode,
            name: input.assetName || payeeName || category.name,
            category: category.name,
            purchaseDate: expenseDate,
            purchaseCost: toStorageString(carriedCost),
            usefulLifeMonths: input.assetUsefulLifeMonths,
            bookValue: toStorageString(carriedCost),
          },
        });
      } else {
        // A category without an account is a configuration gap, not a reason to
        // lose the expense — it goes to miscellaneous and stays visible.
        costAccountId =
          category.accountId ?? accountId(SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE);
      }

      const lines: DraftJournalLine[] = [
        {
          accountId: costAccountId,
          debit: carriedCost,
          narration: input.isCapitalExpenditure
            ? `${input.assetName || category.name} — capitalised`
            : `${category.name}${payeeName ? ` — ${payeeName}` : ""}`,
        },
      ];

      if (itcEligible) {
        const taxLines: Array<[string, Decimal]> = [
          [SYSTEM_ACCOUNT.GST_INPUT_CGST, computed.cgstAmount],
          [SYSTEM_ACCOUNT.GST_INPUT_SGST, computed.sgstAmount],
          [SYSTEM_ACCOUNT.GST_INPUT_IGST, computed.igstAmount],
        ];
        for (const [key, amount] of taxLines) {
          if (!isZero(amount)) {
            lines.push({ accountId: accountId(key), debit: amount });
          }
        }
      }

      const settlementKey = SETTLEMENT_ACCOUNT[input.paymentMode];
      lines.push({
        accountId: settlementKey
          ? accountId(settlementKey)
          : accountId(SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
        credit: computed.lineTotal,
        narration: payeeName ? `Paid to ${payeeName}` : "Expense",
        ...(settlementKey
          ? {}
          : { partyType: PartyType.SUPPLIER, partyId: supplier?.id ?? null }),
      });

      const entry = await postJournalEntry(tx, {
        companyId,
        branchId,
        entryDate: expenseDate,
        voucherType: VoucherType.EXPENSE,
        narration: `${voucherNumber} — ${category.name}${payeeName ? ` (${payeeName})` : ""}`,
        referenceNo: input.referenceNo || voucherNumber,
        sourceType: EXPENSE_SOURCE,
        sourceId: expense.id,
        createdById: params.userId,
        lines,
      });

      await tx.expense.update({
        where: { id: expense.id },
        data: { journalEntryId: entry.id },
      });

      // --- GST register -----------------------------------------------------
      if (!totalTax.isZero()) {
        await writeGstRows(tx, {
          companyId,
          direction: GstDirection.INWARD,
          documentType: "EXPENSE",
          documentId: expense.id,
          documentNumber: voucherNumber,
          documentDate: expenseDate,
          supplyType,
          placeOfSupply: company.stateCode,
          partyName: payeeName ?? category.name,
          partyGstin: supplier?.gstin ?? null,
          itcEligible,
          lines: [{ ...computed, hsnCode: null, taxRateId: null }],
          sign: 1,
        });
      }

      await recordAuditLog(
        {
          action: EXPENSE_AUDIT.POSTED,
          module: "Expenses",
          companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          entityType: "Expense",
          entityId: expense.id,
          metadata: {
            voucherNumber,
            category: category.name,
            payee: payeeName,
            total: toStorageString(computed.lineTotal),
            itcEligible,
            capitalised: input.isCapitalExpenditure,
            assetCode,
            entryNumber: entry.entryNumber,
          },
        },
        tx,
      );

      return {
        id: expense.id,
        voucherNumber,
        totalAmount: toStorageString(computed.lineTotal),
        itcEligible,
        isCapitalExpenditure: input.isCapitalExpenditure,
        assetCode,
        entryNumber: entry.entryNumber,
      };
    },
    { timeout: 30_000 },
  );
}

/**
 * Voids a posted expense.
 *
 * Nothing is deleted. A capitalised expense also has its asset withdrawn from
 * the register — leaving it there would mean depreciating something the books
 * say was never bought.
 */
export async function voidExpense(params: {
  companyId: string;
  expenseId: string;
  userId: string;
  actorEmail: string;
  reason: string;
}): Promise<{ entryNumber: string }> {
  return prisma.$transaction(async (tx) => {
    const expense = await tx.expense.findFirst({
      where: { id: params.expenseId, companyId: params.companyId },
      select: {
        id: true,
        voucherNumber: true,
        expenseDate: true,
        status: true,
        branchId: true,
        totalAmount: true,
        taxableAmount: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        itcEligible: true,
        isCapitalExpenditure: true,
        payeeName: true,
        journalEntryId: true,
        category: { select: { name: true } },
      },
    });

    if (!expense) {
      throw new ExpenseError("That expense could not be found.", "NOT_FOUND");
    }
    if (expense.status === DocumentStatus.VOIDED) {
      throw new ExpenseError(
        "This expense has already been voided.",
        "ALREADY_VOIDED",
      );
    }
    if (expense.status !== DocumentStatus.POSTED) {
      throw new ExpenseError(
        "Only a posted expense can be voided.",
        "NOT_POSTED",
      );
    }

    const entryId = expense.journalEntryId;
    if (!entryId) {
      throw new ExpenseError(
        "This expense has no journal entry to reverse, so it cannot be voided safely.",
        "NO_ENTRY",
      );
    }

    const company = await tx.company.findUniqueOrThrow({
      where: { id: params.companyId },
      select: { stateCode: true },
    });

    const reversal = await reversePostedEntry(tx, {
      companyId: params.companyId,
      entryId,
      branchId: expense.branchId,
      entryDate: expense.expenseDate,
      voucherType: VoucherType.EXPENSE,
      narration: `Void of ${expense.voucherNumber} — ${params.reason}`,
      referenceNo: expense.voucherNumber,
      sourceType: EXPENSE_VOID_SOURCE,
      sourceId: expense.id,
      createdById: params.userId,
    });

    if (expense.isCapitalExpenditure) {
      // Depreciating an asset the books say was never bought would carry the
      // mistake forward for years.
      await tx.fixedAsset.updateMany({
        where: {
          companyId: params.companyId,
          code: `FA-${expense.voucherNumber}`,
        },
        data: { isActive: false, disposedAt: new Date() },
      });
    }

    const totalTax = add(
      expense.cgstAmount,
      expense.sgstAmount,
      expense.igstAmount,
    );

    if (!totalTax.isZero()) {
      await writeGstRows(tx, {
        companyId: params.companyId,
        direction: GstDirection.INWARD,
        documentType: "EXPENSE",
        documentId: expense.id,
        documentNumber: expense.voucherNumber,
        documentDate: expense.expenseDate,
        supplyType: isZero(expense.igstAmount) ? "INTRA_STATE" : "INTER_STATE",
        placeOfSupply: company.stateCode,
        partyName: expense.payeeName ?? expense.category.name,
        partyGstin: null,
        itcEligible: expense.itcEligible,
        lines: [
          {
            grossAmount: money(expense.taxableAmount),
            discountAmount: money(0),
            taxableAmount: money(expense.taxableAmount),
            taxPercent: money(0),
            cgstAmount: money(expense.cgstAmount),
            sgstAmount: money(expense.sgstAmount),
            igstAmount: money(expense.igstAmount),
            cessAmount: money(0),
            lineTotal: money(expense.totalAmount),
            hsnCode: null,
            taxRateId: null,
          },
        ],
        sign: -1,
      });
    }

    await tx.expense.update({
      where: { id: expense.id },
      data: {
        status: DocumentStatus.VOIDED,
        voidedAt: new Date(),
        voidReason: params.reason,
      },
    });

    await recordAuditLog(
      {
        action: EXPENSE_AUDIT.VOIDED,
        module: "Expenses",
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Expense",
        entityId: expense.id,
        metadata: {
          voucherNumber: expense.voucherNumber,
          total: toStorageString(expense.totalAmount),
          reason: params.reason,
          reversalEntry: reversal.entryNumber,
        },
      },
      tx,
    );

    return { entryNumber: reversal.entryNumber };
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const EXPENSE_PAGE_SIZE = 25;

export type ExpenseRow = {
  id: string;
  voucherNumber: string;
  expenseDate: string;
  categoryName: string;
  payeeName: string | null;
  status: DocumentStatus;
  paymentMode: PaymentMode;
  taxableAmount: string;
  taxAmount: string;
  totalAmount: string;
  itcEligible: boolean;
  isCapitalExpenditure: boolean;
};

export type CategoryTotal = {
  categoryId: string;
  name: string;
  total: string;
};

export type ExpenseListResult = {
  rows: ExpenseRow[];
  total: number;
  page: number;
  pageCount: number;
  /** Posted, revenue expenses only — a capitalised item is not a cost. */
  postedExpense: string;
  capitalised: string;
  inputCredit: string;
  byCategory: CategoryTotal[];
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export async function listExpenses(params: {
  companyId: string;
  query?: string;
  categoryId?: string;
  /** Inclusive expense-date window, as `listSales` already accepted. */
  from?: string;
  to?: string;
  page?: number;
}): Promise<ExpenseListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const dateFilter: Prisma.DateTimeFilter = {};
  if (params.from) dateFilter.gte = new Date(`${params.from}T00:00:00.000Z`);
  if (params.to) dateFilter.lte = new Date(`${params.to}T00:00:00.000Z`);

  const where: Prisma.ExpenseWhereInput = {
    companyId: params.companyId,
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(Object.keys(dateFilter).length > 0 ? { expenseDate: dateFilter } : {}),
    ...(query.length >= 1
      ? {
          OR: [
            {
              voucherNumber: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              payeeName: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              referenceNo: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
          ],
        }
      : {}),
  };

  const posted = { ...where, status: DocumentStatus.POSTED };

  const [total, expenses, revenue, capital, credit, grouped, categories] =
    await Promise.all([
      prisma.expense.count({ where }),
      prisma.expense.findMany({
        where,
        select: {
          id: true,
          voucherNumber: true,
          expenseDate: true,
          status: true,
          paymentMode: true,
          payeeName: true,
          taxableAmount: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          totalAmount: true,
          itcEligible: true,
          isCapitalExpenditure: true,
          category: { select: { name: true } },
        },
        orderBy: [{ expenseDate: "desc" }, { voucherNumber: "desc" }],
        skip: (page - 1) * EXPENSE_PAGE_SIZE,
        take: EXPENSE_PAGE_SIZE,
      }),
      prisma.expense.aggregate({
        where: { ...posted, isCapitalExpenditure: false },
        _sum: {
          taxableAmount: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
        },
      }),
      prisma.expense.aggregate({
        where: { ...posted, isCapitalExpenditure: true },
        _sum: { totalAmount: true },
      }),
      prisma.expense.aggregate({
        where: { ...posted, itcEligible: true },
        _sum: { cgstAmount: true, sgstAmount: true, igstAmount: true },
      }),
      prisma.expense.groupBy({
        by: ["categoryId"],
        where: { ...posted, isCapitalExpenditure: false },
        _sum: { taxableAmount: true },
        orderBy: { _sum: { taxableAmount: "desc" } },
        take: 6,
      }),
      prisma.expenseCategory.findMany({
        where: { companyId: params.companyId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);

  const nameById = new Map(categories.map((entry) => [entry.id, entry.name]));

  return {
    rows: expenses.map((expense) => ({
      id: expense.id,
      voucherNumber: expense.voucherNumber,
      expenseDate: isoDay(expense.expenseDate),
      categoryName: expense.category.name,
      payeeName: expense.payeeName,
      status: expense.status,
      paymentMode: expense.paymentMode,
      taxableAmount: toStorageString(expense.taxableAmount),
      taxAmount: toStorageString(
        add(expense.cgstAmount, expense.sgstAmount, expense.igstAmount),
      ),
      totalAmount: toStorageString(expense.totalAmount),
      itcEligible: expense.itcEligible,
      isCapitalExpenditure: expense.isCapitalExpenditure,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / EXPENSE_PAGE_SIZE)),
    // The cost that reached the P&L: the taxable value, plus any tax that could
    // not be reclaimed and therefore formed part of it.
    postedExpense: toStorageString(
      add(
        revenue._sum.taxableAmount ?? 0,
        revenue._sum.cgstAmount ?? 0,
        revenue._sum.sgstAmount ?? 0,
        revenue._sum.igstAmount ?? 0,
      ).minus(
        add(
          credit._sum.cgstAmount ?? 0,
          credit._sum.sgstAmount ?? 0,
          credit._sum.igstAmount ?? 0,
        ),
      ),
    ),
    capitalised: toStorageString(capital._sum.totalAmount ?? 0),
    inputCredit: toStorageString(
      add(
        credit._sum.cgstAmount ?? 0,
        credit._sum.sgstAmount ?? 0,
        credit._sum.igstAmount ?? 0,
      ),
    ),
    byCategory: grouped.map((group) => ({
      categoryId: group.categoryId,
      name: nameById.get(group.categoryId) ?? "—",
      total: toStorageString(group._sum.taxableAmount ?? 0),
    })),
  };
}

export async function getExpense(params: {
  companyId: string;
  expenseId: string;
}) {
  const expense = await prisma.expense.findFirst({
    where: { id: params.expenseId, companyId: params.companyId },
    select: {
      id: true,
      voucherNumber: true,
      expenseDate: true,
      status: true,
      paymentMode: true,
      payeeName: true,
      partyId: true,
      taxableAmount: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      totalAmount: true,
      itcEligible: true,
      isCapitalExpenditure: true,
      referenceNo: true,
      notes: true,
      voidedAt: true,
      voidReason: true,
      journalEntryId: true,
      category: { select: { id: true, name: true } },
      branch: { select: { name: true } },
    },
  });

  if (!expense) {
    throw new MasterDataError("That expense could not be found.", "NOT_FOUND");
  }

  const entry = expense.journalEntryId
    ? await prisma.journalEntry.findFirst({
        where: { id: expense.journalEntryId, companyId: params.companyId },
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

  return { expense, entry };
}

export async function listExpenseCategories(companyId: string) {
  return prisma.expenseCategory.findMany({
    where: { companyId, isActive: true },
    select: { id: true, name: true, accountId: true },
    orderBy: { name: "asc" },
  });
}
