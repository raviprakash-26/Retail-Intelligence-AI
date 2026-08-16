import "server-only";
import { prisma } from "@/lib/db";
import { findStateByCode } from "@/lib/constants/india";
import { getSalesReturn } from "@/server/returns/return-queries";
import type { InvoiceParty } from "@/server/documents/tax-invoice-document";

/**
 * Everything a credit note has to print.
 *
 * The same shape of job as the invoice document beside it, and the same rule:
 * nothing is recomputed. Every figure is the one the return posted, because a
 * note that worked out its own tax could credit a different amount from the one
 * the ledger reversed.
 *
 * The particular that matters most here is the reference to the original
 * invoice. A credit note adjusts a supply that has already been declared, and
 * one that does not say which supply is an adjustment to nothing — a buyer's
 * accountant cannot match it and a return cannot be corrected by it.
 */

export type CreditNoteDocument = {
  supplier: InvoiceParty;
  recipient: InvoiceParty | null;
  noteNumber: string;
  noteDate: Date;
  against: { number: string; date: Date } | null;
  reason: string | null;
  interState: boolean;
  voided: boolean;
  lines: Array<{
    lineNumber: number;
    description: string;
    quantity: string;
    rate: string;
    taxableAmount: string;
    taxPercent: string;
    lineTotal: string;
  }>;
  totals: {
    taxableAmount: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
    cessAmount: string;
    roundOff: string;
    totalAmount: string;
  };
};

function addressOf(parts: Array<string | null | undefined>): string[] {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
}

export async function creditNoteDocument(params: {
  companyId: string;
  returnId: string;
}): Promise<CreditNoteDocument> {
  const [note, company] = await Promise.all([
    getSalesReturn({ companyId: params.companyId, id: params.returnId }),
    prisma.company.findUniqueOrThrow({
      where: { id: params.companyId },
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
    }),
  ]);

  // The return carries the party's name and GSTIN but not their address, and a
  // document has to name the recipient rather than point at a record.
  const customer = await prisma.customer.findFirst({
    where: { companyId: params.companyId, name: note.partyName },
    select: {
      name: true,
      gstin: true,
      addressLine1: true,
      city: true,
      stateCode: true,
      pincode: true,
    },
  });

  const supplierState = company.stateCode
    ? findStateByCode(company.stateCode)
    : null;

  return {
    supplier: {
      name: company.name,
      addressLines: addressOf([
        company.addressLine1,
        company.addressLine2,
        [company.city, company.pincode].filter(Boolean).join(" "),
        company.phone ? `Phone ${company.phone}` : null,
        company.email,
      ]),
      gstin: company.gstin,
      stateName: supplierState?.name ?? null,
      stateCode: company.stateCode,
    },
    recipient: {
      name: note.partyName,
      addressLines: customer
        ? addressOf([
            customer.addressLine1,
            [customer.city, customer.pincode].filter(Boolean).join(" "),
          ])
        : [],
      gstin: note.partyGstin,
      stateName: customer?.stateCode
        ? (findStateByCode(customer.stateCode)?.name ?? null)
        : null,
      stateCode: customer?.stateCode ?? null,
    },
    noteNumber: note.returnNumber,
    noteDate: note.returnDate,
    against: note.against
      ? { number: note.against.number, date: note.against.date }
      : null,
    reason: note.reason,
    interState: Number(note.igstAmount) > 0,
    voided: note.status === "VOIDED",
    lines: note.items.map((item, index) => ({
      lineNumber: index + 1,
      description: item.productName,
      quantity: item.quantity,
      rate: item.rate,
      taxableAmount: item.taxableAmount,
      taxPercent: item.taxPercent,
      lineTotal: item.lineTotal,
    })),
    totals: {
      taxableAmount: note.taxableAmount,
      cgstAmount: note.cgstAmount,
      sgstAmount: note.sgstAmount,
      igstAmount: note.igstAmount,
      cessAmount: note.cessAmount,
      roundOff: note.roundOff,
      totalAmount: note.totalAmount,
    },
  };
}
