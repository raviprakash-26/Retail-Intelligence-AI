import type { InvoiceParty } from "@/server/documents/tax-invoice-document";

/**
 * A party on a document, laid out the same way on every one of them.
 *
 * Shared because an invoice and a credit note name the supplier and the
 * recipient identically, and two copies of this would eventually disagree
 * about whether to print the state code.
 */

export function PartyBlock({
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
