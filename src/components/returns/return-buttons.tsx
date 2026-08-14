"use client";

import { RecordReturnDialog } from "@/components/returns/record-return-dialog";
import {
  createPurchaseReturnAction,
  createSalesReturnAction,
} from "@/server/returns/actions";
import type { ReturnableLine } from "@/server/returns/return-queries";

/**
 * The two directions, each bound to its own action.
 *
 * The dialog itself knows nothing about which action it calls or what the
 * document id is called — `saleId` on one side, `purchaseId` on the other. That
 * belongs here, in eight lines each, rather than as a branch inside the form.
 */

type Props = {
  documentId: string;
  documentNumber: string;
  documentDate: string;
  lines: readonly ReturnableLine[];
};

export function SalesReturnButton({
  documentId,
  documentNumber,
  documentDate,
  lines,
}: Props) {
  return (
    <RecordReturnDialog
      direction="sales"
      documentNumber={documentNumber}
      documentDate={documentDate}
      lines={lines}
      onSubmit={(values) =>
        createSalesReturnAction({ saleId: documentId, ...values })
      }
    />
  );
}

export function PurchaseReturnButton({
  documentId,
  documentNumber,
  documentDate,
  lines,
}: Props) {
  return (
    <RecordReturnDialog
      direction="purchase"
      documentNumber={documentNumber}
      documentDate={documentDate}
      lines={lines}
      onSubmit={(values) =>
        createPurchaseReturnAction({ purchaseId: documentId, ...values })
      }
    />
  );
}
