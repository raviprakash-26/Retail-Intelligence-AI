import "server-only";
import { formatCurrency, formatDate } from "@/lib/format";
import { amountInWords } from "@/lib/documents/tax-invoice";
import type { EmailMessage } from "@/server/email/mailer";
import type { CreditNoteDocument } from "@/server/documents/credit-note-document";
import type { InvoiceDocument } from "@/server/documents/tax-invoice-document";

/**
 * A document, as an email.
 *
 * **Plain text, and complete.** The mailer treats text as the source of truth
 * and HTML as a nicety, and that suits a tax invoice better than it might
 * seem: the particulars have to survive whatever client opens them, and a
 * customer forwarding this to their accountant should be forwarding the figures
 * rather than a link to a page the accountant cannot sign into. So the message
 * carries the invoice, not a pointer to it.
 *
 * It does not carry a PDF. Attaching one would mean generating a second layout
 * and keeping it in step with the printed page — the thing the print view was
 * built to avoid — and the shop already has print-to-PDF if a file is what the
 * customer wants. What this is for is the common case: a credit customer who
 * needs the figures in their inbox.
 *
 * The email says plainly that it is a copy of a document already issued, so
 * nobody treats the arrival of an email as the issuing of an invoice.
 */

const money = (value: string) => formatCurrency(value);

function partyLine(gstin: string | null): string {
  return gstin ? `GSTIN: ${gstin}` : "Not registered under GST";
}

export function taxInvoiceEmail(params: {
  to: string;
  document: InvoiceDocument;
}): EmailMessage {
  const { document } = params;
  const lines = document.lines.map(
    (line) =>
      `  ${line.description}${line.hsnCode ? ` (HSN ${line.hsnCode})` : ""}\n` +
      `    ${line.quantity}${line.unit ? ` ${line.unit}` : ""} × ${money(line.rate)}` +
      ` = ${money(line.taxableAmount)} + ${line.taxPercent}% tax` +
      ` = ${money(line.lineTotal)}`,
  );

  const tax = document.interState
    ? [`IGST: ${money(document.totals.igstAmount)}`]
    : [
        `CGST: ${money(document.totals.cgstAmount)}`,
        `SGST: ${money(document.totals.sgstAmount)}`,
      ];

  return {
    to: params.to,
    subject: `Tax invoice ${document.invoiceNumber} from ${document.supplier.name}`,
    text: [
      `${document.recipient?.name ? `Dear ${document.recipient.name},` : "Hello,"}`,
      "",
      `Here is a copy of tax invoice ${document.invoiceNumber}, issued on ${formatDate(
        document.invoiceDate,
        { style: "long" },
      )}.`,
      "",
      "SUPPLIER",
      `  ${document.supplier.name}`,
      ...document.supplier.addressLines.map((line) => `  ${line}`),
      `  ${partyLine(document.supplier.gstin)}`,
      "",
      "RECIPIENT",
      `  ${document.recipient?.name ?? "Counter sale"}`,
      ...(document.recipient?.addressLines ?? []).map((line) => `  ${line}`),
      `  ${partyLine(document.recipient?.gstin ?? null)}`,
      "",
      `Place of supply: ${document.placeOfSupply.name ?? "—"}`,
      `Tax payable on reverse charge: ${document.reverseCharge ? "Yes" : "No"}`,
      "",
      "ITEMS",
      ...lines,
      "",
      `Taxable value: ${money(document.totals.taxableAmount)}`,
      ...tax.map((line) => `${line}`),
      `Total: ${money(document.totals.totalAmount)}`,
      `In words: ${amountInWords(document.totals.totalAmount)}`,
      ...(document.dueDate
        ? [
            "",
            `Payment due by ${formatDate(document.dueDate, { style: "long" })}.`,
          ]
        : []),
      "",
      "This is a copy of a document already issued, sent for your records.",
      `Please reply to ${document.supplier.name} if anything here looks wrong.`,
    ].join("\n"),
  };
}

export function creditNoteEmail(params: {
  to: string;
  document: CreditNoteDocument;
}): EmailMessage {
  const { document } = params;
  const lines = document.lines.map(
    (line) =>
      `  ${line.description}\n` +
      `    ${line.quantity} × ${money(line.rate)} = ${money(line.taxableAmount)}` +
      ` + ${line.taxPercent}% tax = ${money(line.lineTotal)}`,
  );

  const tax = document.interState
    ? [`IGST credited: ${money(document.totals.igstAmount)}`]
    : [
        `CGST credited: ${money(document.totals.cgstAmount)}`,
        `SGST credited: ${money(document.totals.sgstAmount)}`,
      ];

  return {
    to: params.to,
    subject: `Credit note ${document.noteNumber} from ${document.supplier.name}`,
    text: [
      `${document.recipient?.name ? `Dear ${document.recipient.name},` : "Hello,"}`,
      "",
      `Here is a copy of credit note ${document.noteNumber}, issued on ${formatDate(
        document.noteDate,
        { style: "long" },
      )}.`,
      // The particular that makes the note usable by whoever receives it.
      ...(document.against
        ? [
            "",
            `It is issued against tax invoice ${document.against.number} dated ${formatDate(
              document.against.date,
              { style: "long" },
            )}.`,
          ]
        : []),
      "",
      "SUPPLIER",
      `  ${document.supplier.name}`,
      ...document.supplier.addressLines.map((line) => `  ${line}`),
      `  ${partyLine(document.supplier.gstin)}`,
      "",
      "RECIPIENT",
      `  ${document.recipient?.name ?? "—"}`,
      `  ${partyLine(document.recipient?.gstin ?? null)}`,
      "",
      "ITEMS CREDITED",
      ...lines,
      "",
      `Taxable value credited: ${money(document.totals.taxableAmount)}`,
      ...tax,
      `Total credited: ${money(document.totals.totalAmount)}`,
      `In words: ${amountInWords(document.totals.totalAmount)}`,
      "",
      `Reason: ${document.reason?.trim() || "Goods returned"}`,
      "",
      "This is a copy of a document already issued, sent for your records.",
    ].join("\n"),
  };
}
