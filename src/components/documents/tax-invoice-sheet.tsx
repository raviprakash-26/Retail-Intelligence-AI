import { formatCurrency, formatDate } from "@/lib/format";
import {
  amountInWords,
  INVOICE_COPIES,
  type InvoiceCopy,
} from "@/lib/documents/tax-invoice";
import type {
  InvoiceDocument,
  InvoiceParty,
} from "@/server/documents/tax-invoice-document";

/**
 * The invoice a customer takes away.
 *
 * Laid out for paper rather than for a screen: black on white, borders that
 * survive a monochrome printer, and every particular the rule asks for in a
 * place somebody can point at. The `data-particular` attributes are what the
 * browser suite walks to check nothing was dropped in a layout change — a
 * missing GSTIN on a document a buyer's accountant will read is not a thing to
 * discover from a complaint.
 *
 * It renders on screen too, at the same size, so what somebody sees before
 * pressing print is what comes out.
 */

function PartyBlock({
  party,
  heading,
  testId,
}: {
  party: InvoiceParty;
  heading: string;
  testId: string;
}) {
  return (
    <div className="p-3" data-particular={testId}>
      <p className="text-[0.6875rem] font-semibold tracking-wide uppercase">
        {heading}
      </p>
      <p className="mt-1 font-semibold">{party.name}</p>
      {party.addressLines.map((line) => (
        <p key={line} className="text-xs leading-relaxed">
          {line}
        </p>
      ))}
      {party.gstin ? (
        <p className="mt-1 text-xs">
          <span className="font-medium">GSTIN:</span> {party.gstin}
        </p>
      ) : (
        <p className="mt-1 text-xs italic">Not registered under GST</p>
      )}
      {party.stateName && (
        <p className="text-xs">
          <span className="font-medium">State:</span> {party.stateName}
          {party.stateCode ? ` (${party.stateCode})` : ""}
        </p>
      )}
    </div>
  );
}

export function TaxInvoiceSheet({
  document,
  copy = INVOICE_COPIES[0],
}: {
  document: InvoiceDocument;
  copy?: InvoiceCopy;
}) {
  const { totals, lines, interState } = document;

  return (
    <article className="mx-auto max-w-[210mm] border bg-white text-black print:max-w-none print:border-0">
      <header className="border-b p-4 text-center">
        <p className="text-sm font-semibold tracking-[0.2em] uppercase">
          Tax Invoice
        </p>
        <p className="mt-0.5 text-[0.6875rem]" data-particular="copy-label">
          {copy}
        </p>
        {document.voided && (
          <p className="mt-2 text-sm font-bold tracking-widest uppercase">
            — This invoice has been cancelled —
          </p>
        )}
      </header>

      <div className="grid grid-cols-1 border-b sm:grid-cols-2">
        <div className="border-b sm:border-r sm:border-b-0">
          <PartyBlock
            party={document.supplier}
            heading="Supplier"
            testId="supplier-block"
          />
        </div>
        <div>
          {document.recipient ? (
            <PartyBlock
              party={document.recipient}
              heading="Recipient"
              testId="recipient-block"
            />
          ) : (
            <div className="p-3" data-particular="recipient-block">
              <p className="text-[0.6875rem] font-semibold tracking-wide uppercase">
                Recipient
              </p>
              <p className="mt-1 font-semibold">Counter sale</p>
              <p className="text-xs">Not registered under GST</p>
            </div>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 border-b text-xs sm:grid-cols-4">
        <div className="border-r p-2" data-particular="invoice-number">
          <dt className="font-medium">Invoice number</dt>
          <dd className="mt-0.5 font-semibold">{document.invoiceNumber}</dd>
        </div>
        <div className="border-r p-2" data-particular="invoice-date">
          <dt className="font-medium">Date of issue</dt>
          <dd className="mt-0.5">
            {formatDate(document.invoiceDate, { style: "long" })}
          </dd>
        </div>
        <div className="border-r p-2" data-particular="place-of-supply">
          <dt className="font-medium">Place of supply</dt>
          <dd className="mt-0.5">
            {document.placeOfSupply.name ?? "—"}
            {document.placeOfSupply.code
              ? ` (${document.placeOfSupply.code})`
              : ""}
          </dd>
        </div>
        <div className="p-2" data-particular="reverse-charge">
          <dt className="font-medium">Tax payable on reverse charge</dt>
          <dd className="mt-0.5">{document.reverseCharge ? "Yes" : "No"}</dd>
        </div>
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">
            Goods supplied under invoice {document.invoiceNumber}
          </caption>
          <thead>
            <tr className="border-b bg-black/[0.04]">
              <th scope="col" className="border-r p-2 text-left">
                #
              </th>
              <th scope="col" className="border-r p-2 text-left">
                Description
              </th>
              <th scope="col" className="border-r p-2 text-left">
                HSN
              </th>
              <th scope="col" className="border-r p-2 text-right">
                Qty
              </th>
              <th scope="col" className="border-r p-2 text-right">
                Rate
              </th>
              <th scope="col" className="border-r p-2 text-right">
                Taxable value
              </th>
              <th scope="col" className="border-r p-2 text-right">
                Tax %
              </th>
              <th scope="col" className="p-2 text-right">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.lineNumber} className="border-b">
                <td className="border-r p-2">{line.lineNumber}</td>
                <td className="border-r p-2" data-particular="line-description">
                  {line.description}
                </td>
                <td className="border-r p-2" data-particular="line-hsn">
                  {line.hsnCode ?? "—"}
                </td>
                <td
                  className="tabular-figures border-r p-2 text-right"
                  data-particular="line-quantity"
                >
                  {line.quantity}
                  {line.unit ? ` ${line.unit}` : ""}
                </td>
                <td className="tabular-figures border-r p-2 text-right">
                  {formatCurrency(line.rate)}
                </td>
                <td
                  className="tabular-figures border-r p-2 text-right"
                  data-particular="line-taxable"
                >
                  {formatCurrency(line.taxableAmount)}
                </td>
                <td
                  className="tabular-figures border-r p-2 text-right"
                  data-particular="line-tax-rate"
                >
                  {line.taxPercent}%
                </td>
                <td className="tabular-figures p-2 text-right">
                  {formatCurrency(line.lineTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 border-t sm:grid-cols-2">
        <div className="border-b p-3 sm:border-r sm:border-b-0">
          <p className="text-[0.6875rem] font-semibold tracking-wide uppercase">
            Amount in words
          </p>
          <p className="mt-1 text-xs" data-particular="amount-in-words">
            {amountInWords(totals.totalAmount)}
          </p>
          {document.notes && (
            <p className="mt-3 text-xs leading-relaxed">{document.notes}</p>
          )}
        </div>

        <dl className="text-xs" data-particular="tax-summary">
          <Row label="Taxable value" value={totals.taxableAmount} />
          {Number(totals.discountAmount) > 0 && (
            <Row label="Discount" value={`-${totals.discountAmount}`} />
          )}
          {interState ? (
            <Row label="IGST" value={totals.igstAmount} />
          ) : (
            <>
              <Row label="CGST" value={totals.cgstAmount} />
              <Row label="SGST" value={totals.sgstAmount} />
            </>
          )}
          {Number(totals.cessAmount) > 0 && (
            <Row label="Cess" value={totals.cessAmount} />
          )}
          {Number(totals.roundOff) !== 0 && (
            <Row label="Rounding" value={totals.roundOff} />
          )}
          <div
            className="flex items-baseline justify-between border-t p-2 font-semibold"
            data-particular="invoice-total"
          >
            <dt>Total</dt>
            <dd className="tabular-figures">
              {formatCurrency(totals.totalAmount)}
            </dd>
          </div>
        </dl>
      </div>

      <footer className="grid grid-cols-1 border-t sm:grid-cols-2">
        <div className="border-b p-3 text-[0.6875rem] leading-relaxed sm:border-r sm:border-b-0">
          <p className="font-semibold">Declaration</p>
          <p className="mt-1">
            We declare that this invoice shows the actual price of the goods
            described and that all particulars are true and correct.
          </p>
        </div>
        <div className="p-3 text-right" data-particular="signature">
          <p className="text-[0.6875rem]">For {document.supplier.name}</p>
          <div className="mt-10 border-t pt-1 text-[0.6875rem]">
            Authorised signatory
          </div>
        </div>
      </footer>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b p-2">
      <dt>{label}</dt>
      <dd className="tabular-figures">{formatCurrency(value)}</dd>
    </div>
  );
}
