import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/documents/print-button";
import { TaxInvoiceSheet } from "@/components/documents/tax-invoice-sheet";
import { requirePermission } from "@/server/auth/context";
import { taxInvoiceDocument } from "@/server/documents/tax-invoice-document";
import { MasterDataError } from "@/server/master-data/errors";

export const metadata: Metadata = {
  title: "Tax invoice",
  robots: { index: false, follow: false },
};

/**
 * The document, on its own page.
 *
 * Separate from the invoice detail screen rather than a mode of it. The detail
 * page is for somebody working — it carries the void button, the journal entry,
 * the returns. This page is the piece of paper, and nothing on it belongs to
 * the application.
 */
export default async function TaxInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("sales.view");
  const { id } = await params;

  let document;
  try {
    document = await taxInvoiceDocument({
      companyId: context.company.id,
      saleId: id,
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
          href={`/app/sales/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3.5" />
          Back to the invoice
        </Link>
        <PrintButton label="Print or save as PDF" />
      </div>

      <TaxInvoiceSheet document={document} />
    </div>
  );
}
