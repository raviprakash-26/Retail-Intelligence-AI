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
  /**
   * Whether the document names a customer or a supplier.
   *
   * A counter sale names nobody, and settling its return "to the customer's
   * account" would credit receivables against no party at all — a balance the
   * ageing report reads party by party and so cannot see.
   */
  hasParty: boolean;
  lines: readonly ReturnableLine[];
};

export function SalesReturnButton({
  documentId,
  documentNumber,
  documentDate,
  hasParty,
  lines,
}: Props) {
  return (
    <RecordReturnDialog
      direction="sales"
      documentNumber={documentNumber}
      documentDate={documentDate}
      hasParty={hasParty}
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
  hasParty,
  lines,
}: Props) {
  return (
    <RecordReturnDialog
      direction="purchase"
      documentNumber={documentNumber}
      documentDate={documentDate}
      hasParty={hasParty}
      lines={lines}
      onSubmit={(values) =>
        createPurchaseReturnAction({ purchaseId: documentId, ...values })
      }
    />
  );
}
