import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SettlementDetail } from "@/components/settlements/settlement-detail";
import { toStorageString } from "@/lib/money";
import {
  PAYMENT_PURPOSE_LABELS,
  type PaymentPurpose,
} from "@/lib/validation/settlements";
import { requirePermission } from "@/server/auth/context";
import { MasterDataError } from "@/server/master-data/errors";
import { voidPaymentAction } from "@/server/settlements/actions";
import { getPayment } from "@/server/settlements/settlement-service";

export const metadata: Metadata = {
  title: "Payment",
  robots: { index: false, follow: false },
};

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("payments.view");
  const { id } = await params;

  const detail = await getPayment({
    companyId: context.company.id,
    paymentId: id,
  }).catch((error: unknown) => {
    if (error instanceof MasterDataError) notFound();
    throw error;
  });

  const { payment, entry, documents } = detail;

  const allocated = new Map(
    payment.allocations.map((allocation) => [
      allocation.purchaseId,
      toStorageString(allocation.amount),
    ]),
  );

  return (
    <SettlementDetail
      id={payment.id}
      basePath="/app/payments"
      noun="payment"
      documentNoun="bill"
      documentPath="/app/purchases"
      voucherNumber={payment.voucherNumber}
      date={payment.paymentDate}
      status={payment.status}
      voidedAt={payment.voidedAt}
      voidReason={payment.voidReason}
      amount={toStorageString(payment.amount)}
      paymentMode={payment.paymentMode}
      referenceNo={payment.referenceNo}
      notes={payment.notes}
      kindLabel={
        PAYMENT_PURPOSE_LABELS[payment.purpose as PaymentPurpose]?.label ??
        payment.purpose
      }
      partyLabel="To"
      partyName={payment.supplier?.name ?? null}
      allocations={documents.map((purchase) => ({
        id: purchase.id,
        number: purchase.billNumber,
        date: purchase.billDate,
        allocated: allocated.get(purchase.id) ?? "0",
        total: toStorageString(purchase.totalAmount),
        paid: toStorageString(purchase.paidAmount),
      }))}
      entry={entry}
      canVoid={context.permissions.has("payments.void")}
      onVoid={voidPaymentAction}
    />
  );
}
