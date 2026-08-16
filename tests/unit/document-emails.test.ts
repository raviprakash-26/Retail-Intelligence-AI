import { describe, expect, it } from "vitest";
import {
  creditNoteEmail,
  taxInvoiceEmail,
} from "@/server/documents/document-emails";
import type { CreditNoteDocument } from "@/server/documents/credit-note-document";
import type { InvoiceDocument } from "@/server/documents/tax-invoice-document";

/**
 * A document, as an email.
 *
 * The message carries the figures rather than a link to a page. A customer
 * forwarding this to their accountant should be forwarding the invoice, not a
 * URL the accountant cannot sign into — and the text is what the mailer treats
 * as the real message, so the particulars have to survive in plain text.
 */

const invoice: InvoiceDocument = {
  supplier: {
    name: "Ravi Retail Mart",
    addressLines: ["42 Avenue Road", "Bengaluru 560053"],
    gstin: "29AAAPR1234K1ZP",
    stateName: "Karnataka",
    stateCode: "29",
  },
  recipient: {
    name: "Sharma Provision Store",
    addressLines: ["Mysuru 570001"],
    gstin: "29AAACS1234K1Z9",
    stateName: "Karnataka",
    stateCode: "29",
  },
  invoiceNumber: "INV/2026/0042",
  invoiceDate: new Date("2026-08-15T00:00:00Z"),
  dueDate: new Date("2026-09-14T00:00:00Z"),
  placeOfSupply: { code: "29", name: "Karnataka" },
  interState: false,
  reverseCharge: false,
  voided: false,
  lines: [
    {
      lineNumber: 1,
      description: "Sona Masoori Rice 5kg",
      hsnCode: "1006",
      quantity: "4",
      unit: "PCS",
      rate: "285.0000",
      discountAmount: "0",
      taxableAmount: "1140.0000",
      taxPercent: "5.00",
      cgstAmount: "28.5000",
      sgstAmount: "28.5000",
      igstAmount: "0",
      cessAmount: "0",
      lineTotal: "1197.0000",
    },
  ],
  totals: {
    subTotal: "1140.0000",
    discountAmount: "0",
    taxableAmount: "1140.0000",
    cgstAmount: "28.5000",
    sgstAmount: "28.5000",
    igstAmount: "0",
    cessAmount: "0",
    roundOff: "0",
    totalAmount: "1197.0000",
  },
  notes: null,
};

describe("a tax invoice by email", () => {
  it("names the invoice and the supplier in the subject", () => {
    const sent = taxInvoiceEmail({
      to: "buyer@example.com",
      document: invoice,
    });
    expect(sent.subject).toContain("INV/2026/0042");
    expect(sent.subject).toContain("Ravi Retail Mart");
  });

  it("carries the figures rather than a link to them", () => {
    const sent = taxInvoiceEmail({
      to: "buyer@example.com",
      document: invoice,
    });
    // The whole point: forwardable to an accountant who cannot sign in here.
    expect(sent.text).toContain("Sona Masoori Rice 5kg");
    expect(sent.text).toContain("HSN 1006");
    expect(sent.text).toContain("₹1,197.00");
    expect(sent.text).not.toMatch(/https?:\/\//);
  });

  it("carries both GSTINs, which is what makes it a tax invoice", () => {
    const sent = taxInvoiceEmail({
      to: "buyer@example.com",
      document: invoice,
    });
    expect(sent.text).toContain("29AAAPR1234K1ZP");
    expect(sent.text).toContain("29AAACS1234K1Z9");
  });

  it("splits the tax the way the sale posted it", () => {
    const sent = taxInvoiceEmail({
      to: "buyer@example.com",
      document: invoice,
    });
    expect(sent.text).toContain("CGST");
    expect(sent.text).toContain("SGST");
    // An intra-state supply has no IGST line, and printing one would be wrong.
    expect(sent.text).not.toContain("IGST");
  });

  it("shows IGST alone on an inter-state supply", () => {
    const sent = taxInvoiceEmail({
      to: "buyer@example.com",
      document: {
        ...invoice,
        interState: true,
        totals: {
          ...invoice.totals,
          cgstAmount: "0",
          sgstAmount: "0",
          igstAmount: "57.0000",
        },
      },
    });
    expect(sent.text).toContain("IGST");
    expect(sent.text).not.toContain("CGST");
  });

  it("writes the total in words as well as figures", () => {
    const sent = taxInvoiceEmail({
      to: "buyer@example.com",
      document: invoice,
    });
    expect(sent.text).toContain(
      "One Thousand One Hundred and Ninety Seven Rupees",
    );
  });

  it("says it is a copy of something already issued", () => {
    // So nobody treats the arrival of an email as the issuing of an invoice.
    const sent = taxInvoiceEmail({
      to: "buyer@example.com",
      document: invoice,
    });
    expect(sent.text).toContain("copy of a document already issued");
  });

  it("goes to the address it was given and no other", () => {
    const sent = taxInvoiceEmail({
      to: "buyer@example.com",
      document: invoice,
    });
    expect(sent.to).toBe("buyer@example.com");
  });
});

const note: CreditNoteDocument = {
  supplier: invoice.supplier,
  recipient: invoice.recipient,
  noteNumber: "CN/2026/0007",
  noteDate: new Date("2026-08-16T00:00:00Z"),
  against: { number: "INV/2026/0042", date: new Date("2026-08-15T00:00:00Z") },
  reason: "Two packets damaged in transit",
  interState: false,
  voided: false,
  lines: [
    {
      lineNumber: 1,
      description: "Sona Masoori Rice 5kg",
      quantity: "2",
      rate: "285.0000",
      taxableAmount: "570.0000",
      taxPercent: "5.00",
      lineTotal: "598.5000",
    },
  ],
  totals: {
    taxableAmount: "570.0000",
    cgstAmount: "14.2500",
    sgstAmount: "14.2500",
    igstAmount: "0",
    cessAmount: "0",
    roundOff: "0",
    totalAmount: "598.5000",
  },
};

describe("a credit note by email", () => {
  it("names the invoice it adjusts", () => {
    // Without it the recipient cannot match the credit to anything.
    const sent = creditNoteEmail({ to: "buyer@example.com", document: note });
    expect(sent.text).toContain("INV/2026/0042");
    expect(sent.subject).toContain("CN/2026/0007");
  });

  it("says why the credit was given", () => {
    const sent = creditNoteEmail({ to: "buyer@example.com", document: note });
    expect(sent.text).toContain("Two packets damaged in transit");
  });

  it("says what was credited, not what was sold", () => {
    const sent = creditNoteEmail({ to: "buyer@example.com", document: note });
    expect(sent.text).toContain("credited");
    expect(sent.text).toContain("₹598.50");
  });
});
