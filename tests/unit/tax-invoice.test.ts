import { describe, expect, it } from "vitest";
import {
  amountInWords,
  CREDIT_NOTE_PARTICULARS,
  INVOICE_COPIES,
  INVOICE_PARTICULARS,
} from "@/lib/documents/tax-invoice";

/**
 * What a tax invoice has to say, and how it says the amount.
 *
 * The particulars are checked against the rendered page by the browser suite;
 * these are the pieces that can be checked without one.
 */

describe("the amount in words", () => {
  it("counts in crore and lakh, the way an Indian invoice does", () => {
    expect(amountInWords(10_452_200)).toBe(
      "One Crore Four Lakh Fifty Two Thousand Two Hundred Rupees only",
    );
    expect(amountInWords(104_522)).toBe(
      "One Lakh Four Thousand Five Hundred and Twenty Two Rupees only",
    );
  });

  it("says paise separately, the way the amount is spoken", () => {
    expect(amountInWords(1_250.5)).toBe(
      "One Thousand Two Hundred and Fifty Rupees and Fifty Paise only",
    );
    expect(amountInWords(99.99)).toBe(
      "Ninety Nine Rupees and Ninety Nine Paise only",
    );
  });

  it("joins the last pair with 'and', as the convention has it", () => {
    expect(amountInWords(105)).toBe("One Hundred and Five Rupees only");
    expect(amountInWords(1_005)).toBe("One Thousand and Five Rupees only");
  });

  it("handles the awkward ends", () => {
    expect(amountInWords(0)).toBe("Zero Rupees only");
    expect(amountInWords(1)).toBe("One Rupees only");
    expect(amountInWords(19)).toBe("Nineteen Rupees only");
    expect(amountInWords(20)).toBe("Twenty Rupees only");
    expect(amountInWords(100)).toBe("One Hundred Rupees only");
  });

  it("says so rather than dropping the sign on a negative", () => {
    // A credit note carries one, and an amount silently losing its sign on a
    // document somebody signs would be the worst kind of quiet error.
    expect(amountInWords(-2_500)).toContain("Minus");
  });

  it("never rounds the rupees away", () => {
    // The words are a second statement of the same figure; a mismatch between
    // them and the numerals is what the line exists to prevent.
    expect(amountInWords(1_04_522.4)).toContain(
      "One Lakh Four Thousand Five Hundred and Twenty Two Rupees",
    );
    expect(amountInWords(1_04_522.4)).toContain("Forty Paise");
  });
});

describe("the particulars an invoice must carry", () => {
  it("names each one and where it is shown", () => {
    for (const particular of INVOICE_PARTICULARS) {
      expect(particular.requirement.length).toBeGreaterThan(10);
      expect(particular.testId).toMatch(/^[a-z-]+$/);
    }
  });

  it("covers what the rule asks for", () => {
    // Not an exhaustive reading of Rule 46 — a checklist of the ones a layout
    // change could silently drop, each pinned to the page by the browser suite.
    const keys = INVOICE_PARTICULARS.map((entry) => entry.key);
    for (const required of [
      "supplierName",
      "invoiceNumber",
      "invoiceDate",
      "recipient",
      "hsn",
      "quantity",
      "taxableValue",
      "taxRate",
      "taxAmount",
      "total",
      "placeOfSupply",
      "reverseCharge",
      "signature",
    ]) {
      expect(keys, `${required} is not in the checklist`).toContain(required);
    }
  });

  it("gives every particular a distinct anchor", () => {
    const ids = INVOICE_PARTICULARS.map((entry) => entry.testId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("knows an invoice for goods is issued in triplicate", () => {
    expect(INVOICE_COPIES).toHaveLength(3);
    expect(INVOICE_COPIES[0]).toContain("Recipient");
  });
});

describe("the particulars a credit note must carry", () => {
  it("asks for the invoice it is issued against", () => {
    // The particular an invoice has no equivalent of, and the one that makes
    // the note usable: a credit adjusting a supply nobody can identify is an
    // adjustment to nothing.
    const keys = CREDIT_NOTE_PARTICULARS.map((entry) => entry.key);
    expect(keys).toContain("againstInvoice");
    expect(keys).toContain("nature");
    expect(keys).toContain("taxCredited");
    expect(keys).toContain("signature");
  });

  it("does not ask for an HSN code, which its rule does not require", () => {
    // Rule 46 asks an invoice for one against each line. Rule 53 does not ask
    // a credit note for one, and inventing a requirement would fail documents
    // that are correct.
    const keys = CREDIT_NOTE_PARTICULARS.map((entry) => entry.key);
    expect(keys).not.toContain("hsn");
  });

  it("gives every particular a distinct anchor", () => {
    const ids = CREDIT_NOTE_PARTICULARS.map((entry) => entry.testId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
