import "server-only";
import { prisma } from "@/lib/db";
import { findStateByCode } from "@/lib/constants/india";
import { toStorageString } from "@/lib/money";
import type { InvoiceParty } from "@/server/documents/tax-invoice-document";

/**
 * Proof that money changed hands.
 *
 * The shop could raise an invoice and issue a credit note, and when a customer
 * actually paid — often several thousand rupees in cash against a credit
 * account — they walked away with nothing. A dispute about whether that payment
 * happened had only the shop's own books to settle it, which is precisely the
 * party the customer would be disputing.
 *
 * Both directions share a shape because they are the same document with the
 * parties swapped: a receipt says *we have received from you*, a payment
 * voucher says *we have paid you*, and both want a signature from the side that
 * would otherwise deny it. Money out is the one where the signature matters
 * most — a payment voucher acknowledged by the recipient is what a shop has
 * when a supplier says the cash never arrived.
 *
 * **There is no statutory particulars list here**, and none is invented. A tax
 * invoice has Rule 46 and a credit note has Rule 53; a receipt voucher for
 * settling an existing invoice has no equivalent, so the checklist is what
 * makes the document *useful* rather than what makes it compliant. Claiming
 * otherwise would be this product asserting law it does not know.
 *
 * **Nothing is recomputed.** The amount is the amount posted, and what it was
 * set against is what the allocations recorded. A voucher that worked out its
 * own figures could acknowledge a different sum from the one the ledger moved.
 */

export type VoucherDirection = "RECEIPT" | "PAYMENT";

export type VoucherDocument = {
  direction: VoucherDirection;
  /** The shop. Always the issuer, whichever way the money went. */
  issuer: InvoiceParty;
  /** The customer who paid, or the supplier who was paid. */
  counterparty: { name: string; gstin: string | null } | null;
  voucherNumber: string;
  date: Date;
  amount: string;
  paymentMode: string;
  referenceNo: string | null;
  notes: string | null;
  voided: boolean;
  /** The documents this settled, and how much went against each. */
  against: Array<{
    number: string;
    date: Date;
    total: string;
    allocated: string;
  }>;
  /** Paid on account rather than against any particular document. */
  unallocated: string;
};

function addressOf(parts: Array<string | null | undefined>): string[] {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
}

async function issuerOf(companyId: string): Promise<InvoiceParty> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: {
      name: true,
      gstin: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      stateCode: true,
      pincode: true,
      phone: true,
      email: true,
    },
  });

  return {
    name: company.name,
    addressLines: addressOf([
      company.addressLine1,
      company.addressLine2,
      [company.city, company.pincode].filter(Boolean).join(" "),
      company.phone ? `Phone ${company.phone}` : null,
      company.email,
    ]),
    gstin: company.gstin,
    stateName: company.stateCode
      ? (findStateByCode(company.stateCode)?.name ?? null)
      : null,
    stateCode: company.stateCode,
  };
}

/** Money in, against a customer's invoices. */
export async function receiptVoucherDocument(params: {
  companyId: string;
  receiptId: string;
}): Promise<VoucherDocument | null> {
  const receipt = await prisma.receipt.findFirst({
    where: { id: params.receiptId, companyId: params.companyId },
    select: {
      voucherNumber: true,
      receiptDate: true,
      amount: true,
      paymentMode: true,
      referenceNo: true,
      notes: true,
      voidedAt: true,
      customer: { select: { name: true, gstin: true } },
      allocations: { select: { saleId: true, amount: true } },
    },
  });
  if (!receipt) return null;

  const sales = await prisma.sale.findMany({
    where: {
      companyId: params.companyId,
      id: { in: receipt.allocations.map((entry) => entry.saleId) },
    },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      totalAmount: true,
    },
  });

  const allocated = new Map(
    receipt.allocations.map((entry) => [
      entry.saleId,
      toStorageString(entry.amount),
    ]),
  );

  const against = sales.map((sale) => ({
    number: sale.invoiceNumber,
    date: sale.invoiceDate,
    total: toStorageString(sale.totalAmount),
    allocated: allocated.get(sale.id) ?? "0",
  }));

  return {
    direction: "RECEIPT",
    issuer: await issuerOf(params.companyId),
    counterparty: receipt.customer,
    voucherNumber: receipt.voucherNumber,
    date: receipt.receiptDate,
    amount: toStorageString(receipt.amount),
    paymentMode: receipt.paymentMode,
    referenceNo: receipt.referenceNo,
    notes: receipt.notes,
    voided: Boolean(receipt.voidedAt),
    against,
    unallocated: unallocatedOf(receipt.amount, against),
  };
}

/** Money out, against a supplier's bills. */
export async function paymentVoucherDocument(params: {
  companyId: string;
  paymentId: string;
}): Promise<VoucherDocument | null> {
  const payment = await prisma.payment.findFirst({
    where: { id: params.paymentId, companyId: params.companyId },
    select: {
      voucherNumber: true,
      paymentDate: true,
      amount: true,
      paymentMode: true,
      referenceNo: true,
      notes: true,
      voidedAt: true,
      supplier: { select: { name: true, gstin: true } },
      allocations: { select: { purchaseId: true, amount: true } },
    },
  });
  if (!payment) return null;

  const bills = await prisma.purchase.findMany({
    where: {
      companyId: params.companyId,
      id: { in: payment.allocations.map((entry) => entry.purchaseId) },
    },
    select: {
      id: true,
      billNumber: true,
      billDate: true,
      totalAmount: true,
    },
  });

  const allocated = new Map(
    payment.allocations.map((entry) => [
      entry.purchaseId,
      toStorageString(entry.amount),
    ]),
  );

  const against = bills.map((bill) => ({
    number: bill.billNumber,
    date: bill.billDate,
    total: toStorageString(bill.totalAmount),
    allocated: allocated.get(bill.id) ?? "0",
  }));

  return {
    direction: "PAYMENT",
    issuer: await issuerOf(params.companyId),
    counterparty: payment.supplier,
    voucherNumber: payment.voucherNumber,
    date: payment.paymentDate,
    amount: toStorageString(payment.amount),
    paymentMode: payment.paymentMode,
    referenceNo: payment.referenceNo,
    notes: payment.notes,
    voided: Boolean(payment.voidedAt),
    against,
    unallocated: unallocatedOf(payment.amount, against),
  };
}

/**
 * What was paid on account rather than against a named document.
 *
 * Stated rather than hidden: a customer who pays ₹20,000 against ₹15,000 of
 * invoices has ₹5,000 sitting to their credit, and a voucher that quietly
 * showed only the ₹15,000 would be understating what they handed over.
 */
function unallocatedOf(
  amount: Parameters<typeof toStorageString>[0],
  against: Array<{ allocated: string }>,
): string {
  const total = Number(toStorageString(amount));
  const used = against.reduce((sum, row) => sum + Number(row.allocated), 0);
  const left = total - used;
  return left > 0.0001 ? left.toFixed(4) : "0";
}
