import { money, round2, type MoneyInput } from "@/lib/money";

/**
 * What a tax invoice has to say.
 *
 * A GST-registered business is required to *issue* a tax invoice carrying
 * prescribed particulars — supplier and recipient with their GSTINs, an HSN
 * code against each line, the tax split, the place of supply, whether the tax
 * is payable on reverse charge, and a signature. Rule 46 of the CGST Rules sets
 * the list.
 *
 * This product prepared GSTR-1 working papers out of those invoices for a long
 * time while giving a shop no way to hand one to a customer. The screen showed
 * every figure; there was no document.
 *
 * The particulars are written down here rather than left implicit in a
 * template, so a test can walk a rendered invoice and fail when one is
 * missing. A field quietly dropped in a layout change is exactly the kind of
 * thing nobody notices until a buyer's accountant refuses the invoice.
 *
 * **Nothing here is filed with anybody**, and the document is not a return.
 * Issuing an invoice and filing a return are different acts, and only the first
 * one happens in this product.
 */

export type Particular = {
  key: string;
  /** What Rule 46 asks for, in its own terms. */
  requirement: string;
  /**
   * Where the invoice shows it. Used by the test that walks the rendered page,
   * and by nothing else — the layout is free to move it.
   */
  testId: string;
  /**
   * True where the particular only applies in some cases. A recipient's GSTIN
   * is required where the recipient is registered and cannot be invented where
   * they are not.
   */
  conditional?: boolean;
};

export const INVOICE_PARTICULARS: readonly Particular[] = [
  {
    key: "supplierName",
    requirement: "Name, address and GSTIN of the supplier",
    testId: "supplier-block",
  },
  {
    key: "invoiceNumber",
    requirement: "A consecutive serial number unique for the financial year",
    testId: "invoice-number",
  },
  {
    key: "invoiceDate",
    requirement: "Date of issue",
    testId: "invoice-date",
  },
  {
    key: "recipient",
    requirement: "Name, address and GSTIN of the recipient where registered",
    testId: "recipient-block",
  },
  {
    key: "hsn",
    requirement: "HSN code against each line",
    testId: "line-hsn",
    conditional: true,
  },
  {
    key: "description",
    requirement: "Description of the goods",
    testId: "line-description",
  },
  {
    key: "quantity",
    requirement: "Quantity and unit",
    testId: "line-quantity",
  },
  {
    key: "taxableValue",
    requirement: "Taxable value, after any discount",
    testId: "line-taxable",
  },
  {
    key: "taxRate",
    requirement: "Rate of tax on each line",
    testId: "line-tax-rate",
  },
  {
    key: "taxAmount",
    requirement: "Amount of tax charged, split by head",
    testId: "tax-summary",
  },
  {
    key: "total",
    requirement: "Total value of the supply",
    testId: "invoice-total",
  },
  {
    key: "placeOfSupply",
    requirement: "Place of supply, with the name of the state",
    testId: "place-of-supply",
  },
  {
    key: "reverseCharge",
    requirement: "Whether the tax is payable on reverse charge",
    testId: "reverse-charge",
  },
  {
    key: "signature",
    requirement: "Signature of the supplier or an authorised representative",
    testId: "signature",
  },
];

/**
 * What a credit note has to say.
 *
 * A different list from an invoice's, and shorter. Rule 53 asks for the nature
 * of the document, a serial number, the date, both parties with their GSTINs,
 * **the serial number and date of the invoice it is against**, the taxable
 * value and the tax credited, and a signature. It does not ask for an HSN code
 * against each line the way Rule 46 does.
 *
 * The reference to the original invoice is the particular that matters most: a
 * credit note is an adjustment to a supply already declared, and one that does
 * not say which supply is an adjustment to nothing.
 */
export const CREDIT_NOTE_PARTICULARS: readonly Particular[] = [
  {
    key: "nature",
    requirement: "The nature of the document, said plainly",
    testId: "document-nature",
  },
  {
    key: "supplierName",
    requirement: "Name, address and GSTIN of the supplier",
    testId: "supplier-block",
  },
  {
    key: "noteNumber",
    requirement: "A consecutive serial number unique for the financial year",
    testId: "note-number",
  },
  {
    key: "noteDate",
    requirement: "Date of issue",
    testId: "note-date",
  },
  {
    key: "recipient",
    requirement: "Name, address and GSTIN of the recipient where registered",
    testId: "recipient-block",
  },
  {
    key: "againstInvoice",
    requirement:
      "Serial number and date of the tax invoice this is issued against",
    testId: "against-invoice",
  },
  {
    key: "taxableValue",
    requirement: "Value of the taxable supply credited",
    testId: "credited-taxable",
  },
  {
    key: "taxCredited",
    requirement: "Rate of tax and the amount of tax credited",
    testId: "credited-tax",
  },
  {
    key: "total",
    requirement: "Total amount credited",
    testId: "credit-total",
  },
  {
    key: "reason",
    requirement: "Why the credit is being given",
    testId: "credit-reason",
  },
  {
    key: "signature",
    requirement: "Signature of the supplier or an authorised representative",
    testId: "signature",
  },
];

/**
 * Which copy this is.
 *
 * An invoice for goods is issued in triplicate under Rule 48 — the recipient's
 * copy, the transporter's, and the supplier's. Shops print the ones they need;
 * the label is on the page so whoever holds a copy knows which it is.
 */
export const INVOICE_COPIES = [
  "Original for Recipient",
  "Duplicate for Transporter",
  "Triplicate for Supplier",
] as const;

export type InvoiceCopy = (typeof INVOICE_COPIES)[number];

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function twoDigits(value: number): string {
  if (value < 20) return ONES[value] ?? "";
  const tens = TENS[Math.floor(value / 10)] ?? "";
  const ones = ONES[value % 10] ?? "";
  return ones ? `${tens} ${ones}` : tens;
}

/**
 * Nought to nine hundred and ninety-nine.
 *
 * Every group but the first is a hundred or less by construction — lakh,
 * thousand and hundred are all taken modulo the group above them. The crore
 * count is not: it is whatever is left, so a hundred crore fed to a
 * two-digit reader came back empty and the amount vanished from the line.
 */
function underThousand(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds] ?? ""} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));
  return parts.join(" ");
}

/**
 * The amount written out, the way an Indian invoice writes it.
 *
 * Crore, lakh, thousand, hundred — not million and billion. Every printed
 * invoice in the country carries this line, and it exists because a figure
 * written twice is harder to alter than a figure written once.
 *
 * Paise are stated separately rather than as a fraction, which is how a
 * rupee amount is spoken.
 */
export function amountInWords(value: MoneyInput): string {
  // To the paisa before it is split, not after.
  //
  // Money is carried at four decimal places, and a settlement amount is taken
  // from the form without a decimal constraint, so ₹1,180.9950 reaches here.
  // Splitting first left the rupees at 1,180 and rounded the remainder to 100
  // paise — a hundred, which a reader that only knows nought to ninety-nine
  // renders as nothing. The line read "One Thousand One Hundred and Eighty
  // Rupees and  Paise only": a rupee short, with a hole where the paise
  // belong, on the one line an invoice carries precisely so the figure is
  // written twice and harder to alter.
  const amount = round2(money(value));
  const negative = amount.isNegative();
  const absolute = amount.abs();

  const rupees = absolute.floor().toNumber();
  const paise = Number(absolute.minus(absolute.floor()).times(100).toFixed(0));

  const parts: string[] = [];
  const push = (count: number, label: string) => {
    if (count > 0) parts.push(`${underThousand(count)} ${label}`);
  };

  push(Math.floor(rupees / 10_000_000), "Crore");
  push(Math.floor((rupees % 10_000_000) / 100_000), "Lakh");
  push(Math.floor((rupees % 100_000) / 1_000), "Thousand");
  push(Math.floor((rupees % 1_000) / 100), "Hundred");

  const last = rupees % 100;
  if (last > 0) {
    // "One Hundred and Five", not "One Hundred Five".
    if (parts.length > 0) parts.push("and");
    parts.push(twoDigits(last));
  }

  if (parts.length === 0) parts.push("Zero");

  const words = `${negative ? "Minus " : ""}${parts.join(" ")} Rupees`;
  return paise > 0
    ? `${words} and ${twoDigits(paise)} Paise only`
    : `${words} only`;
}
