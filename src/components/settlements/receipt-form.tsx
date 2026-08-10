"use client";

import { SettlementForm, type PartyOption } from "./settlement-form";
import {
  RECEIPT_SOURCES,
  RECEIPT_SOURCE_LABELS,
  receiptSchema,
  type ReceiptInput,
} from "@/lib/validation/settlements";
import {
  createReceiptAction,
  openInvoicesAction,
} from "@/server/settlements/actions";

/**
 * The receipt side of the shared settlement form.
 *
 * Only the wording and the two actions live here. The customers come from the
 * page — a server component — because the list is the same on every render and
 * has no business being fetched from the browser. What each of them owes is
 * fetched on demand once one is chosen, which is a different question with a
 * different answer every time.
 */
export function ReceiptForm({ customers }: { customers: PartyOption[] }) {
  return (
    <SettlementForm<ReceiptInput>
      schema={receiptSchema}
      kinds={RECEIPT_SOURCES.map((source) => ({
        value: source,
        label: RECEIPT_SOURCE_LABELS[source].label,
        hint: RECEIPT_SOURCE_LABELS[source].hint,
        allocatable: source === "CUSTOMER",
      }))}
      parties={customers}
      copy={{
        partyLabel: "From",
        partyPlaceholder: "Choose a customer",
        kindLabel: "What is this",
        amountLabel: "Received",
        submitLabel: "Record receipt",
        documentNoun: "invoice",
        documentArticle: "an",
        unallocatedNote:
          "Anything not matched still reduces what they owe — it just sits on account.",
        emptyOpenNote:
          "Nothing outstanding for this customer. The receipt will sit on account.",
      }}
      loadOpenDocuments={openInvoicesAction}
      submit={createReceiptAction}
      redirectTo={(id) => `/app/receipts/${id}`}
    />
  );
}
