import "server-only";
import { prisma } from "@/lib/db";
import { findStateByCode } from "@/lib/constants/india";
import { getSale } from "@/server/sales/sale-service";

/**
 * Everything a tax invoice has to print, gathered in one read.
 *
 * The screen already showed the figures; what it never showed was the supplier.
 * A document a customer takes away has to name who issued it, with the address
 * and the GSTIN, and none of that is on the sale — it is on the company. So the
 * document is assembled here rather than in the page, and the page only lays it
 * out.
 *
 * **Nothing is computed.** Every figure comes from the sale as it was posted:
 * the line taxable values, the tax split, the total. An invoice that recomputed
 * its own totals could disagree with the ledger behind it, and the one document
 * in this product that a third party relies on is the last place for that.
 */

export type InvoiceParty = {
  name: string;
  addressLines: string[];
  gstin: string | null;
  stateName: string | null;
  stateCode: string | null;
};

export type InvoiceDocument = {
  supplier: InvoiceParty;
  recipient: InvoiceParty | null;
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate: Date | null;
  placeOfSupply: { code: string | null; name: string | null };
  /** True where this is an inter-state supply and IGST applies. */
  interState: boolean;
  reverseCharge: boolean;
  voided: boolean;
  lines: Array<{
    lineNumber: number;
    description: string;
    hsnCode: string | null;
    quantity: string;
    unit: string | null;
    rate: string;
    discountAmount: string;
    taxableAmount: string;
    taxPercent: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
    cessAmount: string;
    lineTotal: string;
  }>;
  totals: {
    subTotal: string;
    discountAmount: string;
    taxableAmount: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
    cessAmount: string;
    roundOff: string;
    totalAmount: string;
  };
  notes: string | null;
};

function addressOf(parts: Array<string | null | undefined>): string[] {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
}

export async function taxInvoiceDocument(params: {
  companyId: string;
  saleId: string;
}): Promise<InvoiceDocument> {
  const [detail, company] = await Promise.all([
    getSale({ companyId: params.companyId, saleId: params.saleId }),
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

  const sale = detail.sale;

  // The customer's own address, which the sale does not carry — a document has
  // to name the recipient, not just point at a record.
  const customer = sale.customer
    ? await prisma.customer.findFirst({
        where: { id: sale.customer.id, companyId: params.companyId },
        select: {
          name: true,
          gstin: true,
          addressLine1: true,
          city: true,
          stateCode: true,
          pincode: true,
        },
      })
    : null;

  const supplierState = company.stateCode
    ? findStateByCode(company.stateCode)
    : null;
  const placeCode = sale.placeOfSupply ?? customer?.stateCode ?? null;
  const place = placeCode ? findStateByCode(placeCode) : null;

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
    recipient: customer
      ? {
          name: customer.name,
          addressLines: addressOf([
            customer.addressLine1,
            [customer.city, customer.pincode].filter(Boolean).join(" "),
          ]),
          gstin: customer.gstin,
          stateName: customer.stateCode
            ? (findStateByCode(customer.stateCode)?.name ?? null)
            : null,
          stateCode: customer.stateCode,
        }
      : null,
    invoiceNumber: sale.invoiceNumber,
    invoiceDate: sale.invoiceDate,
    dueDate: sale.dueDate,
    placeOfSupply: { code: placeCode, name: place?.name ?? null },
    // Read from the tax that was actually posted rather than recomputed from
    // the two state codes: if they ever disagree, the posted entry is the one
    // the return was built from.
    interState: Number(sale.igstAmount) > 0,
    // Nothing in this product records a sale as reverse charge, and saying
    // "No" is one of the particulars — an invoice silent on it is incomplete.
    reverseCharge: false,
    voided: Boolean(sale.voidedAt),
    lines: sale.items.map((item) => ({
      lineNumber: item.lineNumber,
      description: item.description || item.product?.name || "Item",
      hsnCode: item.hsnCode,
      quantity: item.quantity.toString(),
      unit: item.product?.unit?.code ?? null,
      rate: item.rate.toString(),
      discountAmount: item.discountAmount.toString(),
      taxableAmount: item.taxableAmount.toString(),
      taxPercent: item.taxPercent.toString(),
      cgstAmount: item.cgstAmount.toString(),
      sgstAmount: item.sgstAmount.toString(),
      igstAmount: item.igstAmount.toString(),
      cessAmount: item.cessAmount.toString(),
      lineTotal: item.lineTotal.toString(),
    })),
    totals: {
      subTotal: sale.subTotal.toString(),
      discountAmount: sale.discountAmount.toString(),
      taxableAmount: sale.taxableAmount.toString(),
      cgstAmount: sale.cgstAmount.toString(),
      sgstAmount: sale.sgstAmount.toString(),
      igstAmount: sale.igstAmount.toString(),
      cessAmount: sale.cessAmount.toString(),
      roundOff: sale.roundOff.toString(),
      totalAmount: sale.totalAmount.toString(),
    },
    notes: sale.notes,
  };
}
