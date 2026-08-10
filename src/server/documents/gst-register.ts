import "server-only";
import type { GstDirection, TaxSupplyType } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import { money, toStorageString } from "@/lib/money";
import { groupByRate, type GstLineResult } from "@/lib/tax/gst";

/**
 * The GST register.
 *
 * Every taxable document writes its rows here at posting time, summarised the
 * way a return reports them — by HSN and rate. Building the register as the
 * documents are posted rather than recomputing it later means the return is
 * assembled from the figures the invoice was actually raised with, even if a
 * rate or a price has changed since.
 *
 * Rows are only ever added. Voiding a document appends its negative, flagged as
 * an amendment, so a period someone has already looked at still shows what was
 * there when they looked.
 */

export type GstRegisterLine = GstLineResult & {
  hsnCode: string | null;
  taxRateId: string | null;
};

export async function writeGstRows(
  tx: DbClient,
  params: {
    companyId: string;
    direction: GstDirection;
    documentType: string;
    documentId: string;
    documentNumber: string;
    documentDate: Date;
    supplyType: TaxSupplyType;
    placeOfSupply: string | null;
    partyName: string;
    partyGstin: string | null;
    /** Whether input tax credit may be claimed. Outward supplies: always false. */
    itcEligible?: boolean;
    reverseCharge?: boolean;
    lines: readonly GstRegisterLine[];
    /** -1 writes the reversing rows for a void. */
    sign: 1 | -1;
  },
): Promise<void> {
  const groups = groupByRate(params.lines);
  if (groups.length === 0) return;

  const rateByKey = new Map<string, string | null>();
  for (const line of params.lines) {
    rateByKey.set(
      `${line.hsnCode ?? ""}|${line.taxPercent.toFixed(4)}`,
      line.taxRateId,
    );
  }

  const factor = money(params.sign);

  await tx.gstTransaction.createMany({
    data: groups.map((group) => ({
      companyId: params.companyId,
      taxRateId:
        rateByKey.get(`${group.hsnCode ?? ""}|${group.taxPercent.toFixed(4)}`) ??
        null,
      direction: params.direction,
      documentType: params.documentType,
      documentId: params.documentId,
      documentNumber: params.documentNumber,
      documentDate: params.documentDate,
      periodYear: params.documentDate.getUTCFullYear(),
      periodMonth: params.documentDate.getUTCMonth() + 1,
      partyName: params.partyName,
      partyGstin: params.partyGstin,
      placeOfSupply: params.placeOfSupply,
      supplyType: params.supplyType,
      hsnCode: group.hsnCode,
      taxableValue: toStorageString(group.taxableAmount.times(factor)),
      ratePercent: toStorageString(group.taxPercent),
      cgstAmount: toStorageString(group.cgstAmount.times(factor)),
      sgstAmount: toStorageString(group.sgstAmount.times(factor)),
      igstAmount: toStorageString(group.igstAmount.times(factor)),
      cessAmount: toStorageString(group.cessAmount.times(factor)),
      totalTax: toStorageString(group.totalTax.times(factor)),
      itcEligible: params.itcEligible ?? false,
      reverseCharge: params.reverseCharge ?? false,
      isAmendment: params.sign === -1,
    })),
  });
}
