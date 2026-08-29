import "server-only";
import {
  DocumentStatus,
  PartyType,
  Prisma,
  VoucherType,
  type PaymentMode,
} from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { DraftJournalLine } from "@/lib/accounting/double-entry";
import { add, compare, money, subtract, toStorageString } from "@/lib/money";
import type {
  AllocationInput,
  PaymentInput,
  PaymentPurpose,
  ReceiptInput,
  ReceiptSource,
} from "@/lib/validation/settlements";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { recordAuditLog } from "@/server/audit/audit-log";
import { settledByNotes } from "./outstanding";
import { resolveSystemAccounts } from "@/server/documents/accounts";
import { reversePostedEntry } from "@/server/documents/reversal";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";
import type { DocumentSeriesKey } from "@/lib/documents/sequences";
import { MasterDataError } from "@/server/master-data/errors";

/**
 * Settling what is owed.
 *
 * A receipt and a payment are the same event with the arrow reversed, so the
 * rules that matter live here once: how much a document still owes, whether an
 * allocation is permitted, and what happens to the sub-ledger when one is
 * undone.
 *
 * Two ideas hold the module together.
 *
 * **The control account always moves by the full amount.** Allocation is a
 * sub-ledger matter — which invoice was settled — not a ledger one. Receiving
 * ₹5,000 from a customer reduces receivables by ₹5,000 whether or not anyone
 * says which invoice it was against. Money not matched to a document is an
 * advance, which is a real position a customer can be in.
 *
 * **Allocation never exceeds what is owed.** Over-allocating would report an
 * invoice as more than settled and quietly net away someone else's debt, so the
 * check is against the document's own outstanding figure at the moment of
 * posting, inside the same transaction.
 */

export const SETTLEMENT_AUDIT = {
  RECEIPT_POSTED: "receipt.posted",
  RECEIPT_VOIDED: "receipt.voided",
  PAYMENT_POSTED: "payment.posted",
  PAYMENT_VOIDED: "payment.voided",
} as const;

export const RECEIPT_SOURCE_TYPE = "RECEIPT";
export const RECEIPT_VOID_SOURCE = "RECEIPT_VOID";
export const PAYMENT_SOURCE_TYPE = "PAYMENT";
export const PAYMENT_VOID_SOURCE = "PAYMENT_VOID";

export class SettlementError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "SettlementError";
  }
}

/** Where money lands or leaves from, by how it moved. */
const MONEY_ACCOUNT: Record<PaymentMode, string> = {
  CASH: SYSTEM_ACCOUNT.CASH,
  BANK: SYSTEM_ACCOUNT.BANK,
  UPI: SYSTEM_ACCOUNT.BANK,
  CARD: SYSTEM_ACCOUNT.BANK,
  CHEQUE: SYSTEM_ACCOUNT.BANK,
  CREDIT: SYSTEM_ACCOUNT.CASH,
  OTHER: SYSTEM_ACCOUNT.CASH,
};

/** The other side of a receipt that is not a customer collection. */
const RECEIPT_COUNTER: Record<ReceiptSource, string | null> = {
  CUSTOMER: null,
  CAPITAL: SYSTEM_ACCOUNT.OWNER_CAPITAL,
  LOAN: SYSTEM_ACCOUNT.LOANS_PAYABLE,
  OTHER_INCOME: SYSTEM_ACCOUNT.OTHER_INCOME,
};

/**
 * The other side of a payment that is not a supplier settlement.
 *
 * The five payroll ones settle a debt rather than incurring a cost, and that is
 * the whole of why they exist. A run posts what the month owes — net pay to the
 * staff, the provident fund, the state insurance, the state's professional tax
 * and the tax withheld — and charges the wages to the profit and loss account
 * once, there and then. Nothing could then debit those liabilities. The money
 * going out had to be recorded as an expense of its own, through "Other" into
 * miscellaneous expenses or through the expense form's own `Salary` category
 * straight back into `SALARY_EXPENSE`, so the same wages were charged twice and
 * the debts stood for as long as the business ran payroll.
 */
const PAYMENT_COUNTER: Record<PaymentPurpose, string | null> = {
  SUPPLIER: null,
  STAFF_PAY: SYSTEM_ACCOUNT.SALARY_PAYABLE,
  PROVIDENT_FUND: SYSTEM_ACCOUNT.PF_PAYABLE,
  EMPLOYEE_INSURANCE: SYSTEM_ACCOUNT.ESI_PAYABLE,
  PROFESSIONAL_TAX: SYSTEM_ACCOUNT.PROFESSIONAL_TAX_PAYABLE,
  TDS: SYSTEM_ACCOUNT.TDS_PAYABLE,
  DRAWINGS: SYSTEM_ACCOUNT.DRAWINGS,
  LOAN_REPAYMENT: SYSTEM_ACCOUNT.LOANS_PAYABLE,
  OTHER: SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
};

/**
 * Every account a payment might land on, from the map itself.
 *
 * Listed by hand, this was a second place to remember: a purpose added to the
 * map above and forgotten here resolves to an account that was never loaded and
 * fails at the moment somebody uses it, which is the far side of a form.
 */
const PAYMENT_COUNTER_ACCOUNTS = [
  ...new Set(Object.values(PAYMENT_COUNTER).filter((key) => key !== null)),
];

type AllocationTarget = {
  id: string;
  number: string;
  total: Prisma.Decimal;
  paid: Prisma.Decimal;
  /**
   * What credit or debit notes have already taken off it.
   *
   * Money is not the only thing that settles a document. Without this the
   * guard below read "actually still owes" as total minus payments, and an
   * invoice of 1,180 carrying a 472 credit note would accept a receipt for
   * the whole 1,180 — 472 more than the customer owed — and quietly put their
   * account into credit. The screen already refused it; only the server did
   * not, and the server is the half that decides.
   */
  credited: ReturnType<typeof money>;
};

/**
 * Checks the allocations against what each document actually still owes.
 *
 * Read inside the posting transaction, so two receipts allocated to the same
 * invoice at the same moment cannot both succeed.
 */
function validateAllocations(
  allocations: readonly AllocationInput[],
  targets: ReadonlyMap<string, AllocationTarget>,
  receiptAmount: Prisma.Decimal | ReturnType<typeof money>,
  noun: string,
): Array<{ documentId: string; amount: ReturnType<typeof money> }> {
  const seen = new Set<string>();
  const checked: Array<{
    documentId: string;
    amount: ReturnType<typeof money>;
  }> = [];
  let allocated = money(0);

  for (const allocation of allocations) {
    const amount = money(allocation.amount);
    if (compare(amount, 0) <= 0) continue;

    if (seen.has(allocation.documentId)) {
      throw new SettlementError(
        `The same ${noun} appears twice in the allocation.`,
        "DUPLICATE_ALLOCATION",
      );
    }
    seen.add(allocation.documentId);

    const target = targets.get(allocation.documentId);
    if (!target) {
      throw new SettlementError(
        `One of the ${noun}s being settled could not be found.`,
        "NOT_FOUND",
      );
    }

    const outstanding = subtract(
      target.total,
      add(target.paid, target.credited),
    );
    if (compare(amount, outstanding) > 0) {
      throw new SettlementError(
        `${target.number} only has ${outstanding.toFixed(2)} outstanding; ${amount.toFixed(2)} was allocated to it.`,
        "OVER_ALLOCATED",
      );
    }

    allocated = add(allocated, amount);
    checked.push({ documentId: allocation.documentId, amount });
  }

  if (compare(allocated, receiptAmount) > 0) {
    throw new SettlementError(
      `${allocated.toFixed(2)} has been allocated but only ${money(receiptAmount).toFixed(2)} was ${noun === "invoice" ? "received" : "paid"}.`,
      "ALLOCATION_EXCEEDS_AMOUNT",
    );
  }

  return checked;
}

async function nextVoucher(
  tx: DbClient,
  params: { companyId: string; key: DocumentSeriesKey; date: Date },
): Promise<string> {
  const fiscalYear = await ensureFiscalYearFor(tx, {
    companyId: params.companyId,
    date: params.date,
  });

  return allocateDocumentNumber(tx, {
    companyId: params.companyId,
    key: params.key,
    fiscalYearId: fiscalYear.id,
  });
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export type PostedSettlement = {
  id: string;
  voucherNumber: string;
  amount: string;
  allocated: string;
  unallocated: string;
  entryNumber: string;
};

export async function createReceipt(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: ReceiptInput;
}): Promise<PostedSettlement> {
  const { companyId, input } = params;

  return prisma.$transaction(async (tx) => {
    const receiptDate = new Date(`${input.date}T00:00:00.000Z`);
    const amount = money(input.amount);

    const customer = input.partyId
      ? await tx.customer.findFirst({
          where: { id: input.partyId, companyId },
          select: { id: true, name: true, archivedAt: true },
        })
      : null;

    if (input.partyId && !customer) {
      throw new SettlementError(
        "That customer could not be found.",
        "NOT_FOUND",
        "partyId",
      );
    }
    if (customer?.archivedAt) {
      throw new SettlementError(
        `${customer.name} is archived. Restore them before recording a receipt.`,
        "CUSTOMER_ARCHIVED",
        "partyId",
      );
    }

    // --- Allocations ------------------------------------------------------
    const allocationIds = input.allocations
      .filter((allocation) => allocation.amount > 0)
      .map((allocation) => allocation.documentId);

    const sales = allocationIds.length
      ? await tx.sale.findMany({
          where: {
            companyId,
            id: { in: allocationIds },
            customerId: customer?.id,
            status: DocumentStatus.POSTED,
          },
          select: {
            id: true,
            invoiceNumber: true,
            totalAmount: true,
            paidAmount: true,
          },
        })
      : [];

    // Read on `tx`, so what a credit note has taken off the invoice is seen
    // under the same lock as the payments against it.
    const credited = await settledByNotes(tx, {
      companyId,
      documentIds: sales.map((sale) => sale.id),
      side: "RECEIVABLE",
    });

    const targets = new Map<string, AllocationTarget>(
      sales.map((sale) => [
        sale.id,
        {
          id: sale.id,
          number: sale.invoiceNumber,
          total: sale.totalAmount,
          paid: sale.paidAmount,
          credited: money(credited.get(sale.id) ?? 0),
        },
      ]),
    );

    const checked = validateAllocations(
      input.allocations,
      targets,
      amount,
      "invoice",
    );
    const allocated = add(...checked.map((entry) => entry.amount));
    const unallocated = subtract(amount, allocated);

    // --- Accounts ---------------------------------------------------------
    const accountId = await resolveSystemAccounts(tx, companyId, [
      SYSTEM_ACCOUNT.CASH,
      SYSTEM_ACCOUNT.BANK,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      SYSTEM_ACCOUNT.OWNER_CAPITAL,
      SYSTEM_ACCOUNT.LOANS_PAYABLE,
      SYSTEM_ACCOUNT.OTHER_INCOME,
    ]);

    const depositAccountId = accountId(MONEY_ACCOUNT[input.paymentMode]);
    const counterKey = RECEIPT_COUNTER[input.kind];
    const counterAccountId = counterKey
      ? accountId(counterKey)
      : accountId(SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE);

    const voucherNumber = await nextVoucher(tx, {
      companyId,
      key: "RECEIPT",
      date: receiptDate,
    });

    const receipt = await tx.receipt.create({
      data: {
        companyId,
        customerId: customer?.id ?? null,
        voucherNumber,
        receiptDate,
        status: DocumentStatus.POSTED,
        paymentMode: input.paymentMode,
        depositAccountId,
        source: input.kind,
        counterAccountId: counterKey ? counterAccountId : null,
        amount: toStorageString(amount),
        referenceNo: input.referenceNo || null,
        notes: input.notes || null,
        postedAt: new Date(),
        createdById: params.userId,
      },
      select: { id: true, voucherNumber: true },
    });

    for (const allocation of checked) {
      await tx.receiptAllocation.create({
        data: {
          companyId,
          receiptId: receipt.id,
          saleId: allocation.documentId,
          amount: toStorageString(allocation.amount),
        },
      });
      // The invoice's own settled figure, which is what ageing reads.
      const target = targets.get(allocation.documentId);
      await tx.sale.update({
        where: { id: allocation.documentId },
        data: {
          paidAmount: toStorageString(
            add(target?.paid ?? 0, allocation.amount),
          ),
        },
      });
    }

    // --- The entry --------------------------------------------------------
    const lines: DraftJournalLine[] = [
      {
        accountId: depositAccountId,
        debit: amount,
        narration: customer
          ? `Received from ${customer.name}`
          : "Money received",
      },
      {
        accountId: counterAccountId,
        credit: amount,
        narration: voucherNumber,
        ...(counterKey
          ? {}
          : { partyType: PartyType.CUSTOMER, partyId: customer?.id ?? null }),
      },
    ];

    const entry = await postJournalEntry(tx, {
      companyId,
      entryDate: receiptDate,
      voucherType: VoucherType.RECEIPT,
      narration: `${voucherNumber}${customer ? ` — ${customer.name}` : ""}`,
      referenceNo: input.referenceNo || voucherNumber,
      sourceType: RECEIPT_SOURCE_TYPE,
      sourceId: receipt.id,
      createdById: params.userId,
      lines,
    });

    await tx.receipt.update({
      where: { id: receipt.id },
      data: { journalEntryId: entry.id },
    });

    await recordAuditLog(
      {
        action: SETTLEMENT_AUDIT.RECEIPT_POSTED,
        module: "Receipts",
        companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Receipt",
        entityId: receipt.id,
        metadata: {
          voucherNumber,
          source: input.kind,
          customer: customer?.name ?? null,
          amount: toStorageString(amount),
          allocated: toStorageString(allocated),
          unallocated: toStorageString(unallocated),
          entryNumber: entry.entryNumber,
        },
      },
      tx,
    );

    return {
      id: receipt.id,
      voucherNumber,
      amount: toStorageString(amount),
      allocated: toStorageString(allocated),
      unallocated: toStorageString(unallocated),
      entryNumber: entry.entryNumber,
    };
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function createPayment(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: PaymentInput;
}): Promise<PostedSettlement> {
  const { companyId, input } = params;

  return prisma.$transaction(async (tx) => {
    const paymentDate = new Date(`${input.date}T00:00:00.000Z`);
    const amount = money(input.amount);

    const supplier = input.partyId
      ? await tx.supplier.findFirst({
          where: { id: input.partyId, companyId },
          select: { id: true, name: true, archivedAt: true },
        })
      : null;

    if (input.partyId && !supplier) {
      throw new SettlementError(
        "That supplier could not be found.",
        "NOT_FOUND",
        "partyId",
      );
    }
    if (supplier?.archivedAt) {
      throw new SettlementError(
        `${supplier.name} is archived. Restore them before paying them.`,
        "SUPPLIER_ARCHIVED",
        "partyId",
      );
    }

    const allocationIds = input.allocations
      .filter((allocation) => allocation.amount > 0)
      .map((allocation) => allocation.documentId);

    const purchases = allocationIds.length
      ? await tx.purchase.findMany({
          where: {
            companyId,
            id: { in: allocationIds },
            supplierId: supplier?.id,
            status: DocumentStatus.POSTED,
          },
          select: {
            id: true,
            billNumber: true,
            totalAmount: true,
            paidAmount: true,
          },
        })
      : [];

    const debited = await settledByNotes(tx, {
      companyId,
      documentIds: purchases.map((purchase) => purchase.id),
      side: "PAYABLE",
    });

    const targets = new Map<string, AllocationTarget>(
      purchases.map((purchase) => [
        purchase.id,
        {
          id: purchase.id,
          number: purchase.billNumber,
          total: purchase.totalAmount,
          paid: purchase.paidAmount,
          credited: money(debited.get(purchase.id) ?? 0),
        },
      ]),
    );

    const checked = validateAllocations(
      input.allocations,
      targets,
      amount,
      "bill",
    );
    const allocated = add(...checked.map((entry) => entry.amount));
    const unallocated = subtract(amount, allocated);

    const accountId = await resolveSystemAccounts(tx, companyId, [
      SYSTEM_ACCOUNT.CASH,
      SYSTEM_ACCOUNT.BANK,
      SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
      ...PAYMENT_COUNTER_ACCOUNTS,
    ]);

    const sourceAccountId = accountId(MONEY_ACCOUNT[input.paymentMode]);
    const counterKey = PAYMENT_COUNTER[input.kind];
    const counterAccountId = counterKey
      ? accountId(counterKey)
      : accountId(SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE);

    const voucherNumber = await nextVoucher(tx, {
      companyId,
      key: "PAYMENT",
      date: paymentDate,
    });

    const payment = await tx.payment.create({
      data: {
        companyId,
        supplierId: supplier?.id ?? null,
        voucherNumber,
        paymentDate,
        status: DocumentStatus.POSTED,
        paymentMode: input.paymentMode,
        sourceAccountId,
        purpose: input.kind,
        counterAccountId: counterKey ? counterAccountId : null,
        amount: toStorageString(amount),
        referenceNo: input.referenceNo || null,
        notes: input.notes || null,
        postedAt: new Date(),
        createdById: params.userId,
      },
      select: { id: true, voucherNumber: true },
    });

    for (const allocation of checked) {
      await tx.paymentAllocation.create({
        data: {
          companyId,
          paymentId: payment.id,
          purchaseId: allocation.documentId,
          amount: toStorageString(allocation.amount),
        },
      });
      const target = targets.get(allocation.documentId);
      await tx.purchase.update({
        where: { id: allocation.documentId },
        data: {
          paidAmount: toStorageString(
            add(target?.paid ?? 0, allocation.amount),
          ),
        },
      });
    }

    const lines: DraftJournalLine[] = [
      {
        accountId: counterAccountId,
        debit: amount,
        narration: supplier ? `Paid to ${supplier.name}` : "Money paid",
        ...(counterKey
          ? {}
          : { partyType: PartyType.SUPPLIER, partyId: supplier?.id ?? null }),
      },
      {
        accountId: sourceAccountId,
        credit: amount,
        narration: voucherNumber,
      },
    ];

    const entry = await postJournalEntry(tx, {
      companyId,
      entryDate: paymentDate,
      voucherType: VoucherType.PAYMENT,
      narration: `${voucherNumber}${supplier ? ` — ${supplier.name}` : ""}`,
      referenceNo: input.referenceNo || voucherNumber,
      sourceType: PAYMENT_SOURCE_TYPE,
      sourceId: payment.id,
      createdById: params.userId,
      lines,
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: { journalEntryId: entry.id },
    });

    await recordAuditLog(
      {
        action: SETTLEMENT_AUDIT.PAYMENT_POSTED,
        module: "Payments",
        companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Payment",
        entityId: payment.id,
        metadata: {
          voucherNumber,
          purpose: input.kind,
          supplier: supplier?.name ?? null,
          amount: toStorageString(amount),
          allocated: toStorageString(allocated),
          unallocated: toStorageString(unallocated),
          entryNumber: entry.entryNumber,
        },
      },
      tx,
    );

    return {
      id: payment.id,
      voucherNumber,
      amount: toStorageString(amount),
      allocated: toStorageString(allocated),
      unallocated: toStorageString(unallocated),
      entryNumber: entry.entryNumber,
    };
  });
}

// ---------------------------------------------------------------------------
// Voiding
// ---------------------------------------------------------------------------

/**
 * Undoes a receipt or a payment.
 *
 * The allocations have to come off the documents they settled, or an invoice
 * stays marked as paid by money that was never received and drops out of the
 * ageing for good. The allocation rows themselves are deleted rather than
 * negated: they are sub-ledger workings, not financial records, and the
 * financial record — the entry and its reversal — is what stays.
 */
export async function voidReceipt(params: {
  companyId: string;
  receiptId: string;
  userId: string;
  actorEmail: string;
  reason: string;
}): Promise<{ entryNumber: string }> {
  return prisma.$transaction(async (tx) => {
    const receipt = await tx.receipt.findFirst({
      where: { id: params.receiptId, companyId: params.companyId },
      select: {
        id: true,
        voucherNumber: true,
        receiptDate: true,
        status: true,
        amount: true,
        journalEntryId: true,
        allocations: { select: { id: true, saleId: true, amount: true } },
      },
    });

    if (!receipt) {
      throw new SettlementError(
        "That receipt could not be found.",
        "NOT_FOUND",
      );
    }
    if (receipt.status === DocumentStatus.VOIDED) {
      throw new SettlementError(
        "This receipt has already been voided.",
        "ALREADY_VOIDED",
      );
    }

    const entryId = receipt.journalEntryId;
    if (!entryId) {
      throw new SettlementError(
        "This receipt has no journal entry to reverse, so it cannot be voided safely.",
        "NO_ENTRY",
      );
    }

    for (const allocation of receipt.allocations) {
      const sale = await tx.sale.findUniqueOrThrow({
        where: { id: allocation.saleId },
        select: { paidAmount: true },
      });
      await tx.sale.update({
        where: { id: allocation.saleId },
        data: {
          paidAmount: toStorageString(
            subtract(sale.paidAmount, allocation.amount),
          ),
        },
      });
    }
    await tx.receiptAllocation.deleteMany({ where: { receiptId: receipt.id } });

    const reversal = await reversePostedEntry(tx, {
      companyId: params.companyId,
      entryId,
      branchId: null,
      entryDate: receipt.receiptDate,
      voucherType: VoucherType.RECEIPT,
      narration: `Void of ${receipt.voucherNumber} — ${params.reason}`,
      referenceNo: receipt.voucherNumber,
      sourceType: RECEIPT_VOID_SOURCE,
      sourceId: receipt.id,
      createdById: params.userId,
    });

    await tx.receipt.update({
      where: { id: receipt.id },
      data: {
        status: DocumentStatus.VOIDED,
        voidedAt: new Date(),
        voidReason: params.reason,
      },
    });

    await recordAuditLog(
      {
        action: SETTLEMENT_AUDIT.RECEIPT_VOIDED,
        module: "Receipts",
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Receipt",
        entityId: receipt.id,
        metadata: {
          voucherNumber: receipt.voucherNumber,
          amount: toStorageString(receipt.amount),
          reason: params.reason,
          reversalEntry: reversal.entryNumber,
          unsettled: receipt.allocations.length,
        },
      },
      tx,
    );

    return { entryNumber: reversal.entryNumber };
  });
}

export async function voidPayment(params: {
  companyId: string;
  paymentId: string;
  userId: string;
  actorEmail: string;
  reason: string;
}): Promise<{ entryNumber: string }> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: params.paymentId, companyId: params.companyId },
      select: {
        id: true,
        voucherNumber: true,
        paymentDate: true,
        status: true,
        amount: true,
        journalEntryId: true,
        allocations: { select: { id: true, purchaseId: true, amount: true } },
      },
    });

    if (!payment) {
      throw new SettlementError(
        "That payment could not be found.",
        "NOT_FOUND",
      );
    }
    if (payment.status === DocumentStatus.VOIDED) {
      throw new SettlementError(
        "This payment has already been voided.",
        "ALREADY_VOIDED",
      );
    }

    const entryId = payment.journalEntryId;
    if (!entryId) {
      throw new SettlementError(
        "This payment has no journal entry to reverse, so it cannot be voided safely.",
        "NO_ENTRY",
      );
    }

    for (const allocation of payment.allocations) {
      const purchase = await tx.purchase.findUniqueOrThrow({
        where: { id: allocation.purchaseId },
        select: { paidAmount: true },
      });
      await tx.purchase.update({
        where: { id: allocation.purchaseId },
        data: {
          paidAmount: toStorageString(
            subtract(purchase.paidAmount, allocation.amount),
          ),
        },
      });
    }
    await tx.paymentAllocation.deleteMany({ where: { paymentId: payment.id } });

    const reversal = await reversePostedEntry(tx, {
      companyId: params.companyId,
      entryId,
      branchId: null,
      entryDate: payment.paymentDate,
      voucherType: VoucherType.PAYMENT,
      narration: `Void of ${payment.voucherNumber} — ${params.reason}`,
      referenceNo: payment.voucherNumber,
      sourceType: PAYMENT_VOID_SOURCE,
      sourceId: payment.id,
      createdById: params.userId,
    });

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: DocumentStatus.VOIDED,
        voidedAt: new Date(),
        voidReason: params.reason,
      },
    });

    await recordAuditLog(
      {
        action: SETTLEMENT_AUDIT.PAYMENT_VOIDED,
        module: "Payments",
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Payment",
        entityId: payment.id,
        metadata: {
          voucherNumber: payment.voucherNumber,
          amount: toStorageString(payment.amount),
          reason: params.reason,
          reversalEntry: reversal.entryNumber,
          unsettled: payment.allocations.length,
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

export const SETTLEMENT_PAGE_SIZE = 25;

export type SettlementRow = {
  id: string;
  voucherNumber: string;
  date: string;
  partyName: string | null;
  kind: string;
  status: DocumentStatus;
  paymentMode: PaymentMode;
  amount: string;
  allocated: string;
  referenceNo: string | null;
};

export type SettlementListResult = {
  rows: SettlementRow[];
  total: number;
  page: number;
  pageCount: number;
  postedTotal: string;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export async function listReceipts(params: {
  companyId: string;
  query?: string;
  page?: number;
}): Promise<SettlementListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const where: Prisma.ReceiptWhereInput = {
    companyId: params.companyId,
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
              referenceNo: {
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

  const [total, receipts, posted] = await Promise.all([
    prisma.receipt.count({ where }),
    prisma.receipt.findMany({
      where,
      select: {
        id: true,
        voucherNumber: true,
        receiptDate: true,
        source: true,
        status: true,
        paymentMode: true,
        amount: true,
        referenceNo: true,
        customer: { select: { name: true } },
        allocations: { select: { amount: true } },
      },
      orderBy: [{ receiptDate: "desc" }, { voucherNumber: "desc" }],
      skip: (page - 1) * SETTLEMENT_PAGE_SIZE,
      take: SETTLEMENT_PAGE_SIZE,
    }),
    prisma.receipt.aggregate({
      where: { ...where, status: DocumentStatus.POSTED },
      _sum: { amount: true },
    }),
  ]);

  return {
    rows: receipts.map((receipt) => ({
      id: receipt.id,
      voucherNumber: receipt.voucherNumber,
      date: isoDay(receipt.receiptDate),
      partyName: receipt.customer?.name ?? null,
      kind: receipt.source,
      status: receipt.status,
      paymentMode: receipt.paymentMode,
      amount: toStorageString(receipt.amount),
      allocated: toStorageString(
        add(...receipt.allocations.map((allocation) => allocation.amount)),
      ),
      referenceNo: receipt.referenceNo,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / SETTLEMENT_PAGE_SIZE)),
    postedTotal: toStorageString(posted._sum.amount ?? 0),
  };
}

export async function listPayments(params: {
  companyId: string;
  query?: string;
  page?: number;
}): Promise<SettlementListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const where: Prisma.PaymentWhereInput = {
    companyId: params.companyId,
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
              referenceNo: {
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

  const [total, payments, posted] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      select: {
        id: true,
        voucherNumber: true,
        paymentDate: true,
        purpose: true,
        status: true,
        paymentMode: true,
        amount: true,
        referenceNo: true,
        supplier: { select: { name: true } },
        allocations: { select: { amount: true } },
      },
      orderBy: [{ paymentDate: "desc" }, { voucherNumber: "desc" }],
      skip: (page - 1) * SETTLEMENT_PAGE_SIZE,
      take: SETTLEMENT_PAGE_SIZE,
    }),
    prisma.payment.aggregate({
      where: { ...where, status: DocumentStatus.POSTED },
      _sum: { amount: true },
    }),
  ]);

  return {
    rows: payments.map((payment) => ({
      id: payment.id,
      voucherNumber: payment.voucherNumber,
      date: isoDay(payment.paymentDate),
      partyName: payment.supplier?.name ?? null,
      kind: payment.purpose,
      status: payment.status,
      paymentMode: payment.paymentMode,
      amount: toStorageString(payment.amount),
      allocated: toStorageString(
        add(...payment.allocations.map((allocation) => allocation.amount)),
      ),
      referenceNo: payment.referenceNo,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / SETTLEMENT_PAGE_SIZE)),
    postedTotal: toStorageString(posted._sum.amount ?? 0),
  };
}

/**
 * What each of these documents still owes, netted the way everything else nets.
 *
 * The voucher page shows a "still open" column against every document a receipt
 * or payment was matched to, and it used to work that out on the client as
 * total less paid. That is the definition of settled from before returns
 * existed, so an invoice whose goods had all come back and been credited showed
 * the whole of itself as still open, on the very page somebody opens to check
 * what a payment did.
 *
 * The figure belongs on the server for the same reason it belongs in one
 * function: it is a question about the ledger, not about two columns.
 */
async function withOutstanding<
  T extends {
    id: string;
    totalAmount: Prisma.Decimal;
    paidAmount: Prisma.Decimal;
  },
>(
  documents: readonly T[],
  params: { companyId: string; side: "RECEIVABLE" | "PAYABLE" },
): Promise<Array<T & { outstanding: string }>> {
  const settled = await settledByNotes(prisma, {
    companyId: params.companyId,
    documentIds: documents.map((document) => document.id),
    side: params.side,
  });

  return documents.map((document) => ({
    ...document,
    outstanding: toStorageString(
      subtract(
        document.totalAmount,
        add(document.paidAmount, settled.get(document.id) ?? money(0)),
      ),
    ),
  }));
}

export async function getReceipt(params: {
  companyId: string;
  receiptId: string;
}) {
  const receipt = await prisma.receipt.findFirst({
    where: { id: params.receiptId, companyId: params.companyId },
    select: {
      id: true,
      voucherNumber: true,
      receiptDate: true,
      source: true,
      status: true,
      paymentMode: true,
      amount: true,
      referenceNo: true,
      notes: true,
      voidedAt: true,
      voidReason: true,
      journalEntryId: true,
      customer: { select: { id: true, name: true } },
      allocations: { select: { saleId: true, amount: true } },
    },
  });

  if (!receipt) {
    throw new MasterDataError("That receipt could not be found.", "NOT_FOUND");
  }

  const [entry, sales] = await Promise.all([
    receipt.journalEntryId
      ? prisma.journalEntry.findFirst({
          where: {
            id: receipt.journalEntryId,
            companyId: params.companyId,
          },
          select: {
            entryNumber: true,
            status: true,
            totalDebit: true,
            lines: {
              select: {
                lineNumber: true,
                debit: true,
                credit: true,
                account: { select: { code: true, name: true } },
              },
              orderBy: { lineNumber: "asc" },
            },
          },
        })
      : Promise.resolve(null),
    receipt.allocations.length
      ? prisma.sale.findMany({
          where: {
            companyId: params.companyId,
            id: { in: receipt.allocations.map((entry_) => entry_.saleId) },
          },
          select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
            totalAmount: true,
            paidAmount: true,
          },
        })
      : Promise.resolve([]),
  ]);

  return {
    receipt,
    entry,
    documents: await withOutstanding(sales, {
      companyId: params.companyId,
      side: "RECEIVABLE",
    }),
  };
}

export async function getPayment(params: {
  companyId: string;
  paymentId: string;
}) {
  const payment = await prisma.payment.findFirst({
    where: { id: params.paymentId, companyId: params.companyId },
    select: {
      id: true,
      voucherNumber: true,
      paymentDate: true,
      purpose: true,
      status: true,
      paymentMode: true,
      amount: true,
      referenceNo: true,
      notes: true,
      voidedAt: true,
      voidReason: true,
      journalEntryId: true,
      supplier: { select: { id: true, name: true } },
      allocations: { select: { purchaseId: true, amount: true } },
    },
  });

  if (!payment) {
    throw new MasterDataError("That payment could not be found.", "NOT_FOUND");
  }

  const [entry, purchases] = await Promise.all([
    payment.journalEntryId
      ? prisma.journalEntry.findFirst({
          where: {
            id: payment.journalEntryId,
            companyId: params.companyId,
          },
          select: {
            entryNumber: true,
            status: true,
            totalDebit: true,
            lines: {
              select: {
                lineNumber: true,
                debit: true,
                credit: true,
                account: { select: { code: true, name: true } },
              },
              orderBy: { lineNumber: "asc" },
            },
          },
        })
      : Promise.resolve(null),
    payment.allocations.length
      ? prisma.purchase.findMany({
          where: {
            companyId: params.companyId,
            id: { in: payment.allocations.map((entry_) => entry_.purchaseId) },
          },
          select: {
            id: true,
            billNumber: true,
            billDate: true,
            totalAmount: true,
            paidAmount: true,
          },
        })
      : Promise.resolve([]),
  ]);

  return {
    payment,
    entry,
    documents: await withOutstanding(purchases, {
      companyId: params.companyId,
      side: "PAYABLE",
    }),
  };
}
