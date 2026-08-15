import "server-only";
import { JournalStatus, VoucherType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { Decimal, subtract, toStorageString } from "@/lib/money";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
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
 */

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
      sourceType: "BankTransaction",
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
