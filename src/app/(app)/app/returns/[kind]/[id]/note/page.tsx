import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { CreditNoteSheet } from "@/components/documents/credit-note-sheet";
import { PrintButton } from "@/components/documents/print-button";
import { requirePermission } from "@/server/auth/context";
import { creditNoteDocument } from "@/server/documents/credit-note-document";
import { MasterDataError } from "@/server/master-data/errors";

export const metadata: Metadata = {
  title: "Credit note",
  robots: { index: false, follow: false },
};

/**
 * The credit note, on its own page.
 *
 * Sales returns only. A purchase return produces a debit note the *supplier*
 * issues against us — we are the recipient of that document, not its issuer,
 * and printing one on our own letterhead would be asserting something we have
 * no standing to assert.
 */
export default async function CreditNotePage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const context = await requirePermission("sales.view");
  const { kind, id } = await params;

  if (kind !== "sales") notFound();

  let document;
  try {
    document = await creditNoteDocument({
      companyId: context.company.id,
      returnId: id,
    });
  } catch (error) {
    if (error instanceof MasterDataError) notFound();
    throw error;
  }

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        data-print="hide"
      >
        <Link
          href={`/app/returns/${kind}/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3.5" />
          Back to the credit note
        </Link>
        <PrintButton label="Print or save as PDF" />
      </div>

      <CreditNoteSheet document={document} />
    </div>
  );
}
