import "server-only";
import type { DbClient } from "@/lib/db";
import type { DocumentSeriesKey } from "@/lib/documents/sequences";

/**
 * Allocates the next document number for a tenant.
 *
 * Must run inside the same transaction as the document it numbers. The row is
 * locked for update, so two concurrent sales cannot be handed the same invoice
 * number, and a rolled-back insert releases its number rather than burning it —
 * which is what keeps an invoice series gap-free, and a gap in an invoice
 * series is exactly the thing a tax officer asks about.
 */
export async function allocateDocumentNumber(
  tx: DbClient,
  params: {
    companyId: string;
    /**
     * Typed rather than a bare string, so a series nothing provisions cannot
     * be asked for. See `DocumentSeriesKey`.
     */
    key: DocumentSeriesKey;
    fiscalYearId?: string | null;
  },
): Promise<string> {
  const { companyId, key, fiscalYearId = null } = params;

  // SELECT ... FOR UPDATE serialises concurrent allocations of the same series.
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      prefix: string;
      suffix: string;
      padding: number;
      nextValue: number;
    }>
  >`
    SELECT "id", "prefix", "suffix", "padding", "nextValue"
      FROM "document_sequences"
     WHERE "companyId" = ${companyId}::uuid
       AND "key" = ${key}
       AND "fiscalYearId" IS NOT DISTINCT FROM ${fiscalYearId}::uuid
     FOR UPDATE
  `;

  const sequence = rows[0];
  if (!sequence) {
    throw new Error(
      `No document sequence "${key}" configured for company ${companyId}.`,
    );
  }

  await tx.documentSequence.update({
    where: { id: sequence.id },
    data: { nextValue: sequence.nextValue + 1 },
  });

  const number = String(sequence.nextValue).padStart(sequence.padding, "0");
  return `${sequence.prefix}${number}${sequence.suffix}`;
}
