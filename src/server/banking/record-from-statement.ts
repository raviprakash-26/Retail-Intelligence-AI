import "server-only";
import { JournalStatus, VoucherType } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { Decimal, subtract, toStorageString } from "@/lib/money";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { reversePostedEntry } from "@/server/documents/reversal";
import { resolveSystemAccounts } from "@/server/documents/accounts";
import { recordAuditLog } from "@/server/audit/audit-log";
import { BankAccountError } from "./bank-account-service";

/**
 * Recording the two things that genuinely start life on a bank statement.
 *
 * A bank charge and bank interest are not documents anybody enters — the bank
 * applies them, and the business finds out when the statement arrives. Every
 * other unmatched statement line is a receipt, a payment or an expense, and
 * belongs to the module that owns that document. So this is the only posting
 * the banking module can make, and it is narrow on purpose: a bank page that
 * could post anything would become a second, less careful way into the ledger.
 *
 * The entry goes through `postJournalEntry` like every other entry in the
 * system. Nothing here writes to journal tables directly.
 *
 * Because it is the only posting, it is also the only *un*-posting: undoing one
 * lives at the bottom of this file, for the reason given there.
 */

/**
 * The provenance stamp on an entry this module posted.
 *
 * `sourceId` is the statement line the entry came from, and that is what makes
 * the link on the bank transaction different in kind from a match somebody
 * made by hand. A match is a judgement about two records that already existed
 * separately. This is the entry's own origin: the entry exists *because* of
 * that line and has no other reason to be in the ledger.
 *
 * `unmatchTransaction` reads it from here rather than repeating the string, so
 * the two sides cannot drift apart.
 */
export const STATEMENT_POSTING_SOURCE = "BankTransaction";

/**
 * The reversal of one.
 *
 * A different value because it is a different thing, and its `sourceId` says
 * so too: a posting comes from a statement line, a reversal comes from the
 * entry it cancels. Nothing branches on it — the journal reads it, to name the
 * entry in words rather than print a constant at somebody.
 */
export const STATEMENT_POSTING_REVERSAL_SOURCE = "BANK_STATEMENT_REVERSAL";

/**
 * Was this entry posted from this very statement line?
 *
 * Both halves are the question, and the second is not decoration. Asking only
 * the source type would be asking "did some statement line produce this", and
 * answering a narrower question with a broader one is exactly the shape of the
 * defect this predicate exists to close: the link on the bank transaction was
 * being read as "has this line been recorded", which it is only until somebody
 * unmatches it.
 */
export function isPostedFromStatementLine(
  entry: { sourceType: string | null; sourceId: string | null },
  bankTransactionId: string,
): boolean {
  return (
    entry.sourceType === STATEMENT_POSTING_SOURCE &&
    entry.sourceId === bankTransactionId
  );
}

const KINDS = {
  BANK_CHARGE: {
    /** Money left the account, so the statement line must be OUT. */
    direction: "OUT" as const,
    counterpart: SYSTEM_ACCOUNT.BANK_CHARGES,
    label: "Bank charges",
  },
  INTEREST_PAID: {
    direction: "OUT" as const,
    counterpart: SYSTEM_ACCOUNT.INTEREST_EXPENSE,
    label: "Interest paid to the bank",
  },
  INTEREST_RECEIVED: {
    direction: "IN" as const,
    counterpart: SYSTEM_ACCOUNT.OTHER_INCOME,
    label: "Interest received from the bank",
  },
} as const;

export type StatementPostingKind = keyof typeof KINDS;

export async function recordFromStatement(params: {
  companyId: string;
  bankTransactionId: string;
  kind: StatementPostingKind;
  narration?: string | undefined;
  userId: string;
  actorEmail: string;
}): Promise<{ entryNumber: string; entryId: string }> {
  const definition = KINDS[params.kind];

  const posted = await prisma.$transaction(async (tx) => {
    const transaction = await tx.bankTransaction.findFirst({
      where: { id: params.bankTransactionId, companyId: params.companyId },
      select: {
        id: true,
        txnDate: true,
        description: true,
        referenceNo: true,
        debit: true,
        credit: true,
        journalEntryId: true,
        bankAccount: { select: { accountId: true, name: true } },
      },
    });
    if (!transaction) {
      throw new BankAccountError(
        "That statement line does not belong to this business.",
        "NOT_FOUND",
      );
    }
    if (transaction.journalEntryId !== null) {
      throw new BankAccountError(
        "That line is already matched to an entry.",
        "ALREADY_MATCHED",
      );
    }

    const signed = subtract(
      transaction.debit.toString(),
      transaction.credit.toString(),
    );
    const direction = signed.greaterThan(0) ? "IN" : "OUT";
    if (direction !== definition.direction) {
      // A charge that arrives as money in, or interest received that arrives as
      // money out, means the wrong option was chosen. Posting it anyway would
      // produce an entry that balances and is backwards.
      throw new BankAccountError(
        `${definition.label} has to be recorded against a line that is money ${definition.direction === "IN" ? "in" : "out"}, and that one is money ${direction === "IN" ? "in" : "out"}.`,
        "WRONG_DIRECTION",
      );
    }

    const amount = signed.abs();
    if (amount.lessThanOrEqualTo(0)) {
      throw new BankAccountError("That line has no amount.", "NO_AMOUNT");
    }

    const accounts = await resolveSystemAccounts(tx, params.companyId, [
      definition.counterpart,
    ]);
    const counterpartId = accounts(definition.counterpart);
    const bankAccountId = transaction.bankAccount.accountId;

    const narration =
      params.narration ??
      `${definition.label} — ${transaction.description}`.slice(0, 200);

    const entry = await postJournalEntry(tx, {
      companyId: params.companyId,
      entryDate: transaction.txnDate,
      voucherType:
        definition.direction === "OUT"
          ? VoucherType.PAYMENT
          : VoucherType.RECEIPT,
      narration,
      referenceNo: transaction.referenceNo,
      sourceType: STATEMENT_POSTING_SOURCE,
      sourceId: transaction.id,
      createdById: params.userId,
      status: JournalStatus.POSTED,
      lines:
        definition.direction === "OUT"
          ? [
              // The charge is a cost; the bank balance falls.
              {
                accountId: counterpartId,
                debit: amount,
                credit: new Decimal(0),
                narration,
              },
              {
                accountId: bankAccountId,
                debit: new Decimal(0),
                credit: amount,
                narration,
              },
            ]
          : [
              {
                accountId: bankAccountId,
                debit: amount,
                credit: new Decimal(0),
                narration,
              },
              {
                accountId: counterpartId,
                debit: new Decimal(0),
                credit: amount,
                narration,
              },
            ],
    });

    // Recording it and matching it are one step: the entry exists *because* of
    // this statement line, so leaving it unmatched would invite somebody to
    // record it a second time.
    await tx.bankTransaction.update({
      where: { id: transaction.id },
      data: { journalEntryId: entry.id, reconciledAt: new Date() },
    });

    return {
      entryNumber: entry.entryNumber,
      entryId: entry.id,
      amount: toStorageString(amount),
    };
  });

  await recordAuditLog({
    action: "banking.recorded_from_statement",
    module: "Banking",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "BankTransaction",
    entityId: params.bankTransactionId,
    metadata: {
      kind: params.kind,
      entryNumber: posted.entryNumber,
      amount: posted.amount,
    },
  });

  return { entryNumber: posted.entryNumber, entryId: posted.entryId };
}

/**
 * Undoing one.
 *
 * A statement posting is the only entry in this system with no document behind
 * it. Every other entry is undone by voiding the thing that produced it — an
 * invoice, a bill, an expense — and `reverseManualEntry` covers the entries
 * somebody typed. A bank charge is neither: there is no document to void, and
 * `reverseManualEntry` refuses it because its source is not manual. So the undo
 * has to live here, beside the posting it undoes, and this is the module that
 * is allowed to post at all.
 *
 * It reverses rather than deletes, like every undo in the system: the original
 * keeps its number and its place in the ledger and the reversal cancels it, so
 * a charge that was recorded and taken back can still be shown to have been
 * recorded. The reversal carries the original's date, which means a closed
 * period refuses the whole thing — correctly, because a period that has been
 * agreed is not somewhere to quietly remove an expense from.
 */
export async function reverseStatementPosting(
  tx: DbClient,
  params: {
    companyId: string;
    entry: {
      id: string;
      entryNumber: string;
      entryDate: Date;
      branchId: string | null;
      voucherType: VoucherType;
    };
    userId: string;
  },
): Promise<{ entryNumber: string }> {
  return reversePostedEntry(tx, {
    companyId: params.companyId,
    entryId: params.entry.id,
    branchId: params.entry.branchId,
    entryDate: params.entry.entryDate,
    voucherType: params.entry.voucherType,
    narration: `Reversal of ${params.entry.entryNumber} — statement line unmatched`,
    referenceNo: params.entry.entryNumber,
    sourceType: STATEMENT_POSTING_REVERSAL_SOURCE,
    sourceId: params.entry.id,
    createdById: params.userId,
  });
}
