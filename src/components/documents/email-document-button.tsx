"use client";

import * as React from "react";
import { Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  emailCreditNoteAction,
  emailTaxInvoiceAction,
} from "@/server/documents/actions";

/**
 * Sending the document to the customer it was issued to.
 *
 * No address field, deliberately. The button says who it is going to and the
 * server reads that address off the customer record — there is nowhere for a
 * different one to be typed, which is what keeps this from being a way to send
 * mail from a trusted domain to anybody at all.
 *
 * Where the customer has no address on file the button is not offered, and the
 * reason is said rather than left to be guessed at. A control that looks
 * available and quietly does nothing is worse than one that explains itself.
 */
export function EmailDocumentButton({
  id,
  kind,
  to,
}: {
  id: string;
  kind: "invoice" | "credit-note";
  /** The customer's address, or null where there is none on record. */
  to: string | null;
}) {
  const [pending, setPending] = React.useState(false);

  if (!to) {
    return (
      <p className="text-xs text-muted-foreground">
        Add an email address to this customer to send them a copy.
      </p>
    );
  }

  async function send() {
    setPending(true);
    const action =
      kind === "invoice" ? emailTaxInvoiceAction : emailCreditNoteAction;
    const result = await action({ id });
    setPending(false);

    if (result.ok) toast.success(`Sent to ${result.data.to}`);
    else toast.error(result.message);
  }

  return (
    <Button type="button" variant="outline" onClick={send} disabled={pending}>
      <Mail aria-hidden="true" />
      {pending ? "Sending…" : `Email to ${to}`}
    </Button>
  );
}
