"use client";

import { SettlementForm, type PartyOption } from "./settlement-form";
import {
  PAYMENT_PURPOSES,
  PAYMENT_PURPOSE_LABELS,
  paymentSchema,
  type PaymentInput,
} from "@/lib/validation/settlements";
import {
  createPaymentAction,
  openBillsAction,
} from "@/server/settlements/actions";

/** The payment side of the shared settlement form. See `ReceiptForm`. */
export function PaymentForm({ suppliers }: { suppliers: PartyOption[] }) {
  return (
    <SettlementForm<PaymentInput>
      schema={paymentSchema}
      kinds={PAYMENT_PURPOSES.map((purpose) => ({
        value: purpose,
        label: PAYMENT_PURPOSE_LABELS[purpose].label,
        hint: PAYMENT_PURPOSE_LABELS[purpose].hint,
        allocatable: purpose === "SUPPLIER",
      }))}
      parties={suppliers}
      copy={{
        partyLabel: "To",
        partyPlaceholder: "Choose a supplier",
        kindLabel: "What is this",
        amountLabel: "Paid",
        submitLabel: "Record payment",
        documentNoun: "bill",
        documentArticle: "a",
        unallocatedNote:
          "Anything not matched still reduces what you owe them — it just sits on account.",
        emptyOpenNote:
          "Nothing outstanding for this supplier. The payment will sit on account.",
      }}
      loadOpenDocuments={openBillsAction}
      submit={createPaymentAction}
      redirectTo={(id) => `/app/payments/${id}`}
    />
  );
}
