import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PrintButton } from "@/components/documents/print-button";
import { VoucherSheet } from "@/components/documents/voucher-sheet";
import { requirePermission } from "@/server/auth/context";
import { paymentVoucherDocument } from "@/server/documents/voucher-document";

export const metadata: Metadata = {
  title: "Payment voucher",
  robots: { index: false, follow: false },
};

/**
 * What the shop keeps when it pays somebody.
 *
 * The mirror of the receipt, and the direction where the signature matters
 * most: a payment voucher acknowledged by the supplier is what a shop has when
 * the supplier later says the cash never arrived. Its own ledger saying so is
 * not evidence against the person disputing it.
 */
export default async function PaymentVoucherPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("payments.view");
  const { id } = await params;

  const document = await paymentVoucherDocument({
    companyId: context.company.id,
    paymentId: id,
  });
  if (!document) notFound();

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        data-print="hide"
      >
        <Link
          href={`/app/payments/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3.5" />
          Back to the payment
        </Link>
        <PrintButton label="Print or save as PDF" />
      </div>

      <VoucherSheet document={document} />
    </div>
  );
}
