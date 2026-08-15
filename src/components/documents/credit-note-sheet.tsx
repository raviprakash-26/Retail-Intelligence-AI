import { formatCurrency, formatDate } from "@/lib/format";
import { amountInWords } from "@/lib/documents/tax-invoice";
import { PartyBlock } from "@/components/documents/party-block";
import type { CreditNoteDocument } from "@/server/documents/credit-note-document";

/**
 * The credit note a customer takes away.
 *
 * The same paper treatment as the invoice, and a shorter list of particulars —
 * Rule 53 does not ask for an HSN code against each line the way Rule 46 does.
 * What it does ask for, and what an invoice has no equivalent of, is the serial
 * number and date of the invoice this is issued against. A credit note that
 * does not say which supply it adjusts cannot be matched by the person
 * receiving it.
 */
export function CreditNoteSheet({
  document,
}: {
  document: CreditNoteDocument;
}) {
  const { totals, lines, interState } = document;

  return (
    <article className="mx-auto max-w-[210mm] border bg-white text-black print:max-w-none print:border-0">
      <header className="border-b p-4 text-center">
        <p
          className="text-sm font-semibold tracking-[0.2em] uppercase"
          data-particular="document-nature"
        >
          Credit Note
        </p>
        <p className="mt-0.5 text-[0.6875rem]">
          Issued under section 34 of the CGST Act
        </p>
        {document.voided && (
          <p className="mt-2 text-sm font-bold tracking-widest uppercase">
            — This credit note has been cancelled —
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
          {document.recipient && (
            <PartyBlock
              party={document.recipient}
              heading="Recipient"
              testId="recipient-block"
            />
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 border-b text-xs sm:grid-cols-4">
        <div className="border-r p-2" data-particular="note-number">
          <dt className="font-medium">Credit note number</dt>
          <dd className="mt-0.5 font-semibold">{document.noteNumber}</dd>
        </div>
        <div className="border-r p-2" data-particular="note-date">
          <dt className="font-medium">Date of issue</dt>
          <dd className="mt-0.5">
            {formatDate(document.noteDate, { style: "long" })}
          </dd>
        </div>
        <div className="col-span-2 p-2" data-particular="against-invoice">
          <dt className="font-medium">Against tax invoice</dt>
          <dd className="mt-0.5">
            {document.against ? (
              <>
                <span className="font-semibold">{document.against.number}</span>{" "}
                dated {formatDate(document.against.date, { style: "long" })}
              </>
            ) : (
              "Not issued against a specific invoice"
            )}
          </dd>
        </div>
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">
            Goods credited under note {document.noteNumber}
          </caption>
          <thead>
            <tr className="border-b bg-black/[0.04]">
              <th scope="col" className="border-r p-2 text-left">
                #
              </th>
              <th scope="col" className="border-r p-2 text-left">
                Description
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
                <td className="border-r p-2">{line.description}</td>
                <td className="tabular-figures border-r p-2 text-right">
                  {line.quantity}
                </td>
                <td className="tabular-figures border-r p-2 text-right">
                  {formatCurrency(line.rate)}
                </td>
                <td
                  className="tabular-figures border-r p-2 text-right"
                  data-particular="credited-taxable"
                >
                  {formatCurrency(line.taxableAmount)}
                </td>
                <td className="tabular-figures border-r p-2 text-right">
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
            Amount credited, in words
          </p>
          <p className="mt-1 text-xs">{amountInWords(totals.totalAmount)}</p>
          <p
            className="mt-3 text-xs leading-relaxed"
            data-particular="credit-reason"
          >
            <span className="font-medium">Reason:</span>{" "}
            {document.reason?.trim() || "Goods returned by the recipient"}
          </p>
        </div>

        <dl className="text-xs" data-particular="credited-tax">
          <Row label="Taxable value credited" value={totals.taxableAmount} />
          {interState ? (
            <Row label="IGST credited" value={totals.igstAmount} />
          ) : (
            <>
              <Row label="CGST credited" value={totals.cgstAmount} />
              <Row label="SGST credited" value={totals.sgstAmount} />
            </>
          )}
          {Number(totals.cessAmount) > 0 && (
            <Row label="Cess credited" value={totals.cessAmount} />
          )}
          {Number(totals.roundOff) !== 0 && (
            <Row label="Rounding" value={totals.roundOff} />
          )}
          <div
            className="flex items-baseline justify-between border-t p-2 font-semibold"
            data-particular="credit-total"
          >
            <dt>Total credited</dt>
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
            We declare that the particulars given above are true and correct,
            and that the tax shown has been credited against the invoice named.
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
