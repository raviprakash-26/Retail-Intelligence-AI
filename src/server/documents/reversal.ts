import "server-only";
import { JournalStatus, type VoucherType } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";

/**
 * Reversing a posted entry.
 *
 * The one path by which a business document is undone, shared by every module,
 * because getting it wrong is how an audit trail stops being one.
 *
 * Three rules it exists to hold:
 *
 *   1. **The original is never edited.** Its status moves to REVERSED and
 *      nothing else about it changes — the database triggers enforce that
 *      regardless of what this code intends.
 *   2. **The reversal is derived from the lines that were actually posted**,
 *      not recomputed from the document. If a tax rate or a costing rule has
 *      changed since, a recomputed reversal would not cancel what is in the
 *      books; a mirrored one always does.
 *   3. **Both entries stay POSTED at the line level**, so the ledger holds the
 *      original and its reversal and they net to zero. Hiding the original
 *      would leave a business unable to show a sale ever happened.
 */

export class NoEntryToReverseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoEntryToReverseError";
  }
}

export async function reversePostedEntry(
  tx: DbClient,
  params: {
    companyId: string;
    entryId: string;
    branchId: string | null;
    entryDate: Date;
    voucherType: VoucherType;
    narration: string;
    referenceNo: string | null;
    sourceType: string;
    sourceId: string;
    createdById: string | null;
  },
): Promise<{ id: string; entryNumber: string }> {
  const original = await tx.journalLine.findMany({
    where: { journalEntryId: params.entryId, companyId: params.companyId },
    select: {
      accountId: true,
      debit: true,
      credit: true,
      narration: true,
      partyType: true,
      partyId: true,
    },
    orderBy: { lineNumber: "asc" },
  });

  if (original.length === 0) {
    throw new NoEntryToReverseError(
      "This document's journal entry has no lines, so it cannot be reversed safely.",
    );
  }

  const reversal = await postJournalEntry(tx, {
    companyId: params.companyId,
    branchId: params.branchId,
    entryDate: params.entryDate,
    voucherType: params.voucherType,
    narration: params.narration,
    referenceNo: params.referenceNo,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    createdById: params.createdById,
    isSystem: true,
    reversesId: params.entryId,
    // Each side swapped. Nothing is recalculated.
    lines: original.map((line) => ({
      accountId: line.accountId,
      debit: line.credit,
      credit: line.debit,
      narration: line.narration,
      partyType: line.partyType,
      partyId: line.partyId,
    })),
  });

  // Status only: the trigger rejects any change to a posted entry's financial
  // fields, which is exactly the protection wanted here.
  await tx.journalEntry.update({
    where: { id: params.entryId },
    data: { status: JournalStatus.REVERSED },
  });

  return reversal;
}
