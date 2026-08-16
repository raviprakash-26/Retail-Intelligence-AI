import { formatCurrency, formatDate } from "@/lib/format";
import { amountInWords } from "@/lib/documents/tax-invoice";
import { PartyBlock } from "@/components/documents/party-block";
import type { VoucherDocument } from "@/server/documents/voucher-document";

/**
 * Proof that money changed hands.
 *
 * One layout for both directions, because they are the same document with the
 * parties swapped. The wording is not shared: "received with thanks from" and
 * "paid to" are different claims, and a voucher that hedged between them would
 * be useless to whoever holds it.
 *
 * The signature line belongs to the side that would otherwise deny the
 * transaction — the shop signs a receipt it issues, and the supplier signs the
 * payment voucher acknowledging cash they took. That asymmetry is the whole
 * point of the document, so the label changes with the direction.
 */
export function VoucherSheet({ document }: { document: VoucherDocument }) {
  const isReceipt = document.direction === "RECEIPT";
  const title = isReceipt ? "Receipt Voucher" : "Payment Voucher";

  return (
    <article className="mx-auto max-w-[210mm] border bg-white text-black print:max-w-none print:border-0">
      <header className="border-b p-4 text-center">
        <p
          className="text-sm font-semibold tracking-[0.2em] uppercase"
          data-particular="document-nature"
        >
          {title}
        </p>
        {document.voided && (
          <p className="mt-2 text-sm font-bold tracking-widest uppercase">
            — This voucher has been cancelled —
          </p>
        )}
      </header>

      <div className="grid grid-cols-1 border-b sm:grid-cols-2">
        <div className="border-b sm:border-r sm:border-b-0">
          <PartyBlock
            party={document.issuer}
            heading={isReceipt ? "Received by" : "Paid by"}
            testId="issuer-block"
          />
        </div>
        <div className="p-3" data-particular="counterparty-block">
          <p className="text-[0.6875rem] font-semibold tracking-wide uppercase">
            {isReceipt ? "Received from" : "Paid to"}
          </p>
          <p className="mt-1 font-semibold">
            {document.counterparty?.name ?? "—"}
          </p>
          {document.counterparty?.gstin && (
            <p className="mt-1 text-xs">
              <span className="font-medium">GSTIN:</span>{" "}
              {document.counterparty.gstin}
            </p>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 border-b text-xs sm:grid-cols-4">
        <div className="border-r p-2" data-particular="voucher-number">
          <dt className="font-medium">Voucher number</dt>
          <dd className="mt-0.5 font-semibold">{document.voucherNumber}</dd>
        </div>
        <div className="border-r p-2" data-particular="voucher-date">
          <dt className="font-medium">Date</dt>
          <dd className="mt-0.5">
            {formatDate(document.date, { style: "long" })}
          </dd>
        </div>
        <div className="border-r p-2" data-particular="payment-mode">
          <dt className="font-medium">By</dt>
          <dd className="mt-0.5">{document.paymentMode}</dd>
        </div>
        <div className="p-2">
          <dt className="font-medium">Reference</dt>
          <dd className="mt-0.5">{document.referenceNo || "—"}</dd>
        </div>
      </dl>

      <div className="border-b p-4 text-center" data-particular="amount">
        <p className="text-[0.6875rem] tracking-wide uppercase">
          {isReceipt ? "Received with thanks" : "Paid"}
        </p>
        <p className="tabular-figures mt-1 text-2xl font-semibold">
          {formatCurrency(document.amount)}
        </p>
        <p className="mt-1 text-xs" data-particular="amount-in-words">
          {amountInWords(document.amount)}
        </p>
      </div>

      {document.against.length > 0 && (
        <div className="overflow-x-auto border-b">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">
              What this voucher was set against
            </caption>
            <thead>
              <tr className="border-b bg-black/[0.04]">
                <th scope="col" className="border-r p-2 text-left">
                  {isReceipt ? "Invoice" : "Bill"}
                </th>
                <th scope="col" className="border-r p-2 text-left">
                  Dated
                </th>
                <th scope="col" className="border-r p-2 text-right">
                  Its total
                </th>
                <th scope="col" className="p-2 text-right">
                  Set against it
                </th>
              </tr>
            </thead>
            <tbody data-particular="allocations">
              {document.against.map((row) => (
                <tr key={row.number} className="border-b">
                  <td className="border-r p-2">{row.number}</td>
                  <td className="border-r p-2">
                    {formatDate(row.date, { style: "medium" })}
                  </td>
                  <td className="tabular-figures border-r p-2 text-right">
                    {formatCurrency(row.total)}
                  </td>
                  <td className="tabular-figures p-2 text-right">
                    {formatCurrency(row.allocated)}
                  </td>
                </tr>
              ))}
              {Number(document.unallocated) > 0 && (
                <tr className="border-b">
                  <td className="border-r p-2 italic" colSpan={3}>
                    On account, not set against any{" "}
                    {isReceipt ? "invoice" : "bill"}
                  </td>
                  <td className="tabular-figures p-2 text-right">
                    {formatCurrency(document.unallocated)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {document.against.length === 0 && (
        <p
          className="border-b p-3 text-xs italic"
          data-particular="allocations"
        >
          {isReceipt ? "Received" : "Paid"} on account, not set against any
          particular {isReceipt ? "invoice" : "bill"}.
        </p>
      )}

      <footer className="grid grid-cols-1 sm:grid-cols-2">
        <div className="border-b p-3 text-[0.6875rem] leading-relaxed sm:border-r sm:border-b-0">
          {document.notes && <p>{document.notes}</p>}
          <p className={document.notes ? "mt-2" : undefined}>
            {isReceipt
              ? "Subject to realisation where payment is by cheque."
              : "Please acknowledge receipt of the amount stated above."}
          </p>
        </div>
        <div className="p-3 text-right" data-particular="signature">
          <p className="text-[0.6875rem]">
            {isReceipt
              ? `For ${document.issuer.name}`
              : `Received by ${document.counterparty?.name ?? "the payee"}`}
          </p>
          <div className="mt-10 border-t pt-1 text-[0.6875rem]">
            {/* The side that would otherwise deny it is the side that signs. */}
            {isReceipt ? "Authorised signatory" : "Signature of the recipient"}
          </div>
        </div>
      </footer>
    </article>
  );
}
