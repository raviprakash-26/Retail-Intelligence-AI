import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/documents/print-button";
import { VoucherSheet } from "@/components/documents/voucher-sheet";
import { requirePermission } from "@/server/auth/context";
import { receiptVoucherDocument } from "@/server/documents/voucher-document";

export const metadata: Metadata = {
  title: "Receipt voucher",
  robots: { index: false, follow: false },
};

/**
 * What the customer takes away when they pay.
 *
 * A credit customer settling several thousand rupees in cash had nothing to
 * show for it, and a dispute about whether the payment happened had only the
 * shop's own books to settle it — which is the party they would be disputing.
 */
export default async function ReceiptVoucherPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("receipts.view");
  const { id } = await params;

  const document = await receiptVoucherDocument({
    companyId: context.company.id,
    receiptId: id,
  });
  if (!document) notFound();

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        data-print="hide"
      >
        <Link
          href={`/app/receipts/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3.5" />
          Back to the receipt
        </Link>
        <PrintButton label="Print or save as PDF" />
      </div>

      <VoucherSheet document={document} />
    </div>
  );
}
