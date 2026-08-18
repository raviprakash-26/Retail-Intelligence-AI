import "server-only";
import { JournalStatus, type VoucherType } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import {
  assertBalanced,
  condenseLines,
  type DraftJournalLine,
} from "@/lib/accounting/double-entry";
import { toStorageString } from "@/lib/money";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";
import { NoFiscalPeriodError, PeriodClosedError } from "@/server/fiscal/errors";

// Raised here since the first entry was posted, and imported from here by every
// action that reports them. They moved next to the calendar that now also
// raises them; this keeps the existing import path working.
export { NoFiscalPeriodError, PeriodClosedError };

/**
 * The only way a journal entry enters the system.
 *
 * Business modules describe *what happened* as a set of draft lines; this
 * function is responsible for everything that makes it a valid accounting
 * record — balance validation, period resolution, numbering, and writing the
 * entry and its lines as one atomic unit.
 *
 * The caller must supply a transaction client. Posting outside a transaction
 * would allow an entry to exist without its lines, which the database's
 * deferred balance trigger would reject anyway — but failing at the boundary
 * with a clear message beats a constraint violation from three layers down.
 */

export type PostJournalEntryInput = {
  companyId: string;
  branchId?: string | null;
  entryDate: Date;
  voucherType: VoucherType;
  lines: readonly DraftJournalLine[];
  narration?: string | null;
  referenceNo?: string | null;
  /** Links the entry back to the document that caused it. */
  sourceType?: string | null;
  sourceId?: string | null;
  createdById?: string | null;
  /** System-generated entries (opening balances, depreciation, close). */
  isSystem?: boolean;
  /**
   * The posted entry this one reverses.
   *
   * Set on the *reversing* entry, not on the original. Both entries stay in the
   * ledger and cancel each other out — deleting the original is impossible by
   * design, and hiding it would leave a business unable to show that a sale
   * happened at all before it was undone.
   */
  reversesId?: string | null;
  /** Post immediately, or leave as an editable draft. */
  status?: Extract<JournalStatus, "DRAFT" | "POSTED">;
  /**
   * Lets this entry land in a period that is closed.
   *
   * For the year-end closing entry and its reversal, and nothing else. Closing
   * a year requires every month of it to be shut first, so by the time the
   * entry that *performs* the close is written there is no open period left for
   * it to go in. The guard below is otherwise the whole point of closing a
   * period, so this is deliberately not a general escape: it is passed by
   * `year-close-service` and by no other caller.
   */
  intoClosedPeriod?: boolean;
};

export type PostedJournalEntry = {
  id: string;
  entryNumber: string;
  totalDebit: string;
  totalCredit: string;
};

export async function postJournalEntry(
  tx: DbClient,
  input: PostJournalEntryInput,
): Promise<PostedJournalEntry> {
  const status = input.status ?? JournalStatus.POSTED;

  // Merging duplicate postings happens before validation so the balance check
  // runs against exactly what will be written.
  const condensed = condenseLines(input.lines);

  const entry = assertBalanced({
    entryDate: input.entryDate,
    voucherType: input.voucherType,
    narration: input.narration,
    referenceNo: input.referenceNo,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    lines: condensed,
  });

  // --- Resolve the period the entry falls in ------------------------------
  // Opens the fiscal year first where time has moved past the calendar. It
  // refuses a date no year should exist for, so a typed-in 2035 still lands on
  // `NoFiscalPeriodError` rather than quietly creating a year to hold it.
  await ensureFiscalYearFor(tx, {
    companyId: input.companyId,
    date: input.entryDate,
  });

  const period = await tx.fiscalPeriod.findFirst({
    where: {
      companyId: input.companyId,
      startDate: { lte: input.entryDate },
      endDate: { gte: input.entryDate },
    },
    select: { id: true, status: true, fiscalYearId: true },
  });

  if (!period) {
    throw new NoFiscalPeriodError(input.entryDate);
  }
  if (
    status === JournalStatus.POSTED &&
    period.status !== "OPEN" &&
    !input.intoClosedPeriod
  ) {
    throw new PeriodClosedError(input.entryDate);
  }

  const entryNumber = await allocateDocumentNumber(tx, {
    companyId: input.companyId,
    key: "JOURNAL",
    fiscalYearId: period.fiscalYearId,
  });

  const postedAt = status === JournalStatus.POSTED ? new Date() : null;

  const created = await tx.journalEntry.create({
    data: {
      companyId: input.companyId,
      branchId: input.branchId ?? null,
      fiscalYearId: period.fiscalYearId,
      fiscalPeriodId: period.id,
      entryNumber,
      entryDate: input.entryDate,
      voucherType: input.voucherType,
      status,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      referenceNo: input.referenceNo ?? null,
      narration: input.narration ?? null,
      totalDebit: toStorageString(entry.totalDebit),
      totalCredit: toStorageString(entry.totalCredit),
      isSystem: input.isSystem ?? false,
      reversesId: input.reversesId ?? null,
      postedAt,
      postedById:
        status === JournalStatus.POSTED ? (input.createdById ?? null) : null,
      createdById: input.createdById ?? null,
      lines: {
        create: entry.lines.map((line) => ({
          companyId: input.companyId,
          accountId: line.accountId,
          lineNumber: line.lineNumber,
          debit: toStorageString(line.debit),
          credit: toStorageString(line.credit),
          narration: line.narration,
          partyType: line.partyType,
          partyId: line.partyId,
          entryDate: input.entryDate,
          status,
        })),
      },
    },
    select: { id: true, entryNumber: true },
  });

  return {
    id: created.id,
    entryNumber: created.entryNumber,
    totalDebit: toStorageString(entry.totalDebit),
    totalCredit: toStorageString(entry.totalCredit),
  };
}
