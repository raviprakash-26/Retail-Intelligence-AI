import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SettlementDetail } from "@/components/settlements/settlement-detail";
import { toStorageString } from "@/lib/money";
import {
  RECEIPT_SOURCE_LABELS,
  type ReceiptSource,
} from "@/lib/validation/settlements";
import { requirePermission } from "@/server/auth/context";
import { MasterDataError } from "@/server/master-data/errors";
import { voidReceiptAction } from "@/server/settlements/actions";
import { getReceipt } from "@/server/settlements/settlement-service";

export const metadata: Metadata = {
  title: "Receipt",
  robots: { index: false, follow: false },
};

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("receipts.view");
  const { id } = await params;

  const detail = await getReceipt({
    companyId: context.company.id,
    receiptId: id,
  }).catch((error: unknown) => {
    if (error instanceof MasterDataError) notFound();
    throw error;
  });

  const { receipt, entry, documents } = detail;

  const allocated = new Map(
    receipt.allocations.map((allocation) => [
      allocation.saleId,
      toStorageString(allocation.amount),
    ]),
  );

  return (
    <SettlementDetail
      id={receipt.id}
      basePath="/app/receipts"
      noun="receipt"
      documentNoun="invoice"
      documentPath="/app/sales"
      voucherNumber={receipt.voucherNumber}
      date={receipt.receiptDate}
      status={receipt.status}
      voidedAt={receipt.voidedAt}
      voidReason={receipt.voidReason}
      amount={toStorageString(receipt.amount)}
      paymentMode={receipt.paymentMode}
      referenceNo={receipt.referenceNo}
      notes={receipt.notes}
      kindLabel={
        RECEIPT_SOURCE_LABELS[receipt.source as ReceiptSource]?.label ??
        receipt.source
      }
      partyLabel="From"
      partyName={receipt.customer?.name ?? null}
      allocations={documents.map((sale) => ({
        id: sale.id,
        number: sale.invoiceNumber,
        date: sale.invoiceDate,
        allocated: allocated.get(sale.id) ?? "0",
        total: toStorageString(sale.totalAmount),
        paid: toStorageString(sale.paidAmount),
      }))}
      entry={entry}
      canVoid={context.permissions.has("receipts.void")}
      onVoid={voidReceiptAction}
    />
  );
}
