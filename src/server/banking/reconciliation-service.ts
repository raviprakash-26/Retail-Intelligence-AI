import "server-only";
import { JournalStatus } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { Decimal, add, subtract, toStorageString } from "@/lib/money";
import {
  reconciliationDifference,
  suggestMatches,
  type ReconciliationDifference,
  type SuggestedMatch,
} from "@/lib/banking/matching";
import type { StatementDirection } from "@/lib/banking/statement-parser";
import { recordAuditLog } from "@/server/audit/audit-log";
import { BankAccountError } from "./bank-account-service";

/**
 * Reconciling a bank account.
 *
 * Two sequences of movements over the same window: what the bank says, and what
 * the books say. This module compares them and reports the difference. It does
 * not compute either side — the book side is journal lines that the accounting
 * engine posted, and the bank side is exactly what was imported.
 *
 * Matching a statement line to a journal entry writes a link and nothing else.
 * It never posts, never adjusts, and never changes an amount. A reconciliation
 * that could quietly fix a difference would not be a reconciliation.
 */

export type BookMovement = {
  journalEntryId: string;
  entryNumber: string;
  entryDate: Date;
  narration: string | null;
  referenceNo: string | null;
  voucherType: string;
  amount: string;
  direction: StatementDirection;
  matchedTransactionId: string | null;
  /** When the statement line it was matched to is dated, if it is matched. */
  matchedTransactionDate: Date | null;
};

export type StatementMovement = {
  id: string;
  txnDate: Date;
  description: string;
  referenceNo: string | null;
  amount: string;
  direction: StatementDirection;
  matchedEntryId: string | null;
  matchedEntryNumber: string | null;
  /** When the entry it was matched to is dated, if it is matched. */
  matchedEntryDate: Date | null;
  reconciledAt: Date | null;
};

export type ReconciliationView = {
  bankAccount: { id: string; name: string; accountId: string };
  from: Date;
  to: Date;
  statement: StatementMovement[];
  book: BookMovement[];
  unmatchedStatement: StatementMovement[];
  unmatchedBook: BookMovement[];
  suggestions: SuggestedMatch[];
  difference: ReconciliationDifference;
  /** True when nothing has ever been imported for this account. */
  neverImported: boolean;
};

/**
 * Every journal line that touched the bank's ledger account, as a movement.
 *
 * One line per entry per direction: a single entry can debit and credit the
 * same account (a transfer between two of the company's own accounts), and
 * netting those would hide a movement the statement will show separately.
 * Drafts are excluded — an unposted entry is not money that has moved.
 */
async function bookMovements(
  client: DbClient,
  params: {
    companyId: string;
    accountId: string;
    /** Omitted reads everything up to `to`, which is what outstanding means. */
    from?: Date;
    to: Date;
  },
): Promise<BookMovement[]> {
  const lines = await client.journalLine.findMany({
    where: {
      companyId: params.companyId,
      accountId: params.accountId,
      status: JournalStatus.POSTED,
      entryDate: params.from
        ? { gte: params.from, lte: params.to }
        : { lte: params.to },
    },
    orderBy: [{ entryDate: "asc" }, { lineNumber: "asc" }],
    select: {
      debit: true,
      credit: true,
      narration: true,
      journalEntry: {
        select: {
          id: true,
          entryNumber: true,
          entryDate: true,
          narration: true,
          referenceNo: true,
          voucherType: true,
          bankTransactions: { select: { id: true, txnDate: true } },
        },
      },
    },
  });

  const movements: BookMovement[] = [];
  for (const line of lines) {
    const debit = new Decimal(line.debit.toString());
    const credit = new Decimal(line.credit.toString());
    const isDebit = debit.greaterThan(0);
    if (!isDebit && !credit.greaterThan(0)) continue;

    movements.push({
      journalEntryId: line.journalEntry.id,
      entryNumber: line.journalEntry.entryNumber,
      entryDate: line.journalEntry.entryDate,
      narration: line.narration ?? line.journalEntry.narration,
      referenceNo: line.journalEntry.referenceNo,
      voucherType: line.journalEntry.voucherType,
      amount: toStorageString(isDebit ? debit : credit),
      // A debit to a bank asset is money arriving.
      direction: isDebit ? "IN" : "OUT",
      matchedTransactionId: line.journalEntry.bankTransactions[0]?.id ?? null,
      matchedTransactionDate:
        line.journalEntry.bankTransactions[0]?.txnDate ?? null,
    });
  }
  return movements;
}

async function statementMovements(
  client: DbClient,
  params: {
    companyId: string;
    bankAccountId: string;
    /** Omitted reads everything up to `to`, which is what outstanding means. */
    from?: Date;
    to: Date;
  },
): Promise<StatementMovement[]> {
  const rows = await client.bankTransaction.findMany({
    where: {
      companyId: params.companyId,
      bankAccountId: params.bankAccountId,
      txnDate: params.from
        ? { gte: params.from, lte: params.to }
        : { lte: params.to },
    },
    orderBy: [{ txnDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      txnDate: true,
      description: true,
      referenceNo: true,
      debit: true,
      credit: true,
      journalEntryId: true,
      reconciledAt: true,
      journalEntry: { select: { entryNumber: true, entryDate: true } },
    },
  });

  return rows.map((row) => {
    const debit = new Decimal(row.debit.toString());
    const isDebit = debit.greaterThan(0);
    return {
      id: row.id,
      txnDate: row.txnDate,
      description: row.description,
      referenceNo: row.referenceNo,
      amount: toStorageString(isDebit ? debit : row.credit.toString()),
      direction: isDebit ? ("IN" as const) : ("OUT" as const),
      matchedEntryId: row.journalEntryId,
      matchedEntryNumber: row.journalEntry?.entryNumber ?? null,
      matchedEntryDate: row.journalEntry?.entryDate ?? null,
      reconciledAt: row.reconciledAt,
    };
  });
}

/**
 * The book balance of the bank account as at a date.
 *
 * Read from posted journal lines, which is the only place a balance comes from
 * anywhere in this system. It is deliberately not the sum of the movements
 * shown on the page: those start at `from`, and the balance has to include
 * everything before it.
 */
async function bookBalanceAsAt(
  client: DbClient,
  params: { companyId: string; accountId: string; to: Date },
): Promise<Decimal> {
  const totals = await client.journalLine.aggregate({
    where: {
      companyId: params.companyId,
      accountId: params.accountId,
      status: JournalStatus.POSTED,
      entryDate: { lte: params.to },
    },
    _sum: { debit: true, credit: true },
  });
  return subtract(
    totals._sum.debit?.toString() ?? 0,
    totals._sum.credit?.toString() ?? 0,
  );
}

/**
 * The statement balance as at a date: everything imported up to it.
 *
 * The bank's own running balance column is not used, even where the file
 * carried one. It is only present on some exports, it reflects transactions we
 * may not have imported, and preferring it would mean the same account
 * reconciled differently depending on which bank produced the file.
 */
async function statementBalanceAsAt(
  client: DbClient,
  params: { companyId: string; bankAccountId: string; to: Date },
): Promise<Decimal> {
  const totals = await client.bankTransaction.aggregate({
    where: {
      companyId: params.companyId,
      bankAccountId: params.bankAccountId,
      txnDate: { lte: params.to },
    },
    _sum: { debit: true, credit: true },
  });
  return subtract(
    totals._sum.debit?.toString() ?? 0,
    totals._sum.credit?.toString() ?? 0,
  );
}

export async function reconciliationView(params: {
  companyId: string;
  bankAccountId: string;
  from: Date;
  to: Date;
}): Promise<ReconciliationView | null> {
  const bankAccount = await prisma.bankAccount.findFirst({
    where: { id: params.bankAccountId, companyId: params.companyId },
    select: { id: true, name: true, accountId: true },
  });
  if (!bankAccount) return null;

  // Read to the end of the period rather than across it, then narrow.
  //
  // A reconciliation has two different spans in it and they were the same one.
  // The balances have always been read as at `to` — a balance is cumulative or
  // it is not a balance — while what is outstanding was read only inside the
  // window. So the identity was computed from two spans, and a cheque written
  // in April and unpresented at the end of May was in the balance and not in
  // the outstanding items: the whole of it, and of everything else before the
  // window, came out as an unexplained gap. On a fixture with an opening
  // balance that was ₹1,93,000 of accusation against a shop with nothing wrong.
  //
  // Worse, it could not be put right. That cheque was absent from May's
  // unmatched list and the statement line that cleared it was absent from
  // April's, so there was no view from which the two could be matched at all.
  //
  // Outstanding means outstanding as at a date, which is what the classic
  // reconciliation statement means by it.
  const [allStatement, allBook, importedCount] = await Promise.all([
    statementMovements(prisma, {
      companyId: params.companyId,
      bankAccountId: bankAccount.id,
      to: params.to,
    }),
    bookMovements(prisma, {
      companyId: params.companyId,
      accountId: bankAccount.accountId,
      to: params.to,
    }),
    prisma.bankTransaction.count({
      where: { companyId: params.companyId, bankAccountId: bankAccount.id },
    }),
  ]);

  // What happened in the period, which is what the page lists as its activity.
  const statement = allStatement.filter(
    (row) => row.txnDate >= params.from && row.txnDate <= params.to,
  );
  const book = allBook.filter(
    (row) => row.entryDate >= params.from && row.entryDate <= params.to,
  );

  // What is still outstanding at the end of it, whenever it arose.
  //
  // Outstanding is a question about a date, and being matched is not an answer
  // to it. A cheque written on 28 April and paid by the bank on 5 May is an
  // unpresented cheque as at 30 April whether or not anybody has linked it to
  // the line that cleared it — that item is the reason a reconciliation
  // statement exists at all.
  //
  // Reading it as "unmatched" instead made the two sides disagree about `to`.
  // The balances are cumulative as at `to` and these lists are read to `to`,
  // but matchedness was evaluated with no regard to any date: the April cheque
  // stayed in the April book balance while dropping out of April's outstanding
  // items the moment it was matched, and the May statement line that would
  // have balanced it is outside every figure on the page. So April reported
  // the whole cheque as an unexplained gap.
  //
  // What makes that worse than the arithmetic being off is when it happened.
  // Before the match, April reconciled. Matching is the correct thing to do
  // and the thing the page asks for — and it is what broke April, silently,
  // after the month had been agreed and probably closed.
  //
  // So the counterpart's own date decides: matched across the boundary is
  // still outstanding on this side of it.
  const outstandingStatement = allStatement.filter(
    (row) =>
      row.matchedEntryId === null ||
      (row.matchedEntryDate !== null && row.matchedEntryDate > params.to),
  );
  const outstandingBook = allBook.filter(
    (row) =>
      row.matchedTransactionId === null ||
      (row.matchedTransactionDate !== null &&
        row.matchedTransactionDate > params.to),
  );

  // Suggestions are the other question, and the one place the difference
  // between the two matters. An item already matched to something after the
  // window needs no suggestion — `matchTransaction` would refuse it — so these
  // are the strictly unmatched, not the outstanding.
  const unlinkedStatement = allStatement.filter(
    (row) => row.matchedEntryId === null,
  );
  const unlinkedBook = allBook.filter(
    (row) => row.matchedTransactionId === null,
  );

  const [perBooks, perStatement] = await Promise.all([
    bookBalanceAsAt(prisma, {
      companyId: params.companyId,
      accountId: bankAccount.accountId,
      to: params.to,
    }),
    statementBalanceAsAt(prisma, {
      companyId: params.companyId,
      bankAccountId: bankAccount.id,
      to: params.to,
    }),
  ]);

  return {
    bankAccount,
    from: params.from,
    to: params.to,
    statement,
    book,
    unmatchedStatement: outstandingStatement,
    unmatchedBook: outstandingBook,
    suggestions: suggestMatches(
      unlinkedStatement.map((row) => ({
        id: row.id,
        date: row.txnDate,
        amount: row.amount,
        direction: row.direction,
        description: row.description,
        referenceNo: row.referenceNo,
      })),
      unlinkedBook.map((row) => ({
        id: row.journalEntryId,
        date: row.entryDate,
        amount: row.amount,
        direction: row.direction,
        narration: row.narration,
        referenceNo: row.referenceNo,
      })),
    ),
    difference: reconciliationDifference({
      perBooks,
      perStatement,
      unmatchedBook: outstandingBook,
      unmatchedStatement: outstandingStatement,
    }),
    neverImported: importedCount === 0,
  };
}

/**
 * Links one statement line to one journal entry.
 *
 * Both sides are re-read inside the transaction and checked against the company
 * asking, because the ids arrive from a browser. Neither record's figures are
 * touched: the only columns written are the link and the time it was made.
 */
export async function matchTransaction(params: {
  companyId: string;
  bankTransactionId: string;
  journalEntryId: string;
  userId: string;
  actorEmail: string;
}): Promise<{ bankTransactionId: string; entryNumber: string }> {
  const result = await prisma.$transaction(async (tx) => {
    const transaction = await tx.bankTransaction.findFirst({
      where: { id: params.bankTransactionId, companyId: params.companyId },
      select: {
        id: true,
        journalEntryId: true,
        debit: true,
        credit: true,
        bankAccount: { select: { accountId: true } },
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
        "That statement line is already matched. Unmatch it first.",
        "ALREADY_MATCHED",
      );
    }

    const entry = await tx.journalEntry.findFirst({
      where: {
        id: params.journalEntryId,
        companyId: params.companyId,
        status: JournalStatus.POSTED,
      },
      select: {
        id: true,
        entryNumber: true,
        lines: {
          where: { accountId: transaction.bankAccount.accountId },
          select: { debit: true, credit: true },
        },
        bankTransactions: { select: { id: true } },
      },
    });
    if (!entry) {
      throw new BankAccountError(
        "That journal entry does not belong to this business, or is not posted.",
        "NOT_FOUND",
      );
    }
    if (entry.bankTransactions.length > 0) {
      throw new BankAccountError(
        "That journal entry is already matched to another statement line.",
        "ALREADY_MATCHED",
      );
    }

    // The entry has to actually touch this bank's ledger account. Without this
    // somebody could match a statement line to a rent expense entry that never
    // went near the bank, and the reconciliation would report itself settled
    // while the two sides had nothing to do with each other.
    if (entry.lines.length === 0) {
      throw new BankAccountError(
        "That entry does not touch this bank account, so it cannot be what the statement line is.",
        "WRONG_ACCOUNT",
      );
    }

    const entryAmount = entry.lines.reduce(
      (total, line) =>
        add(total, line.debit.toString()).minus(line.credit.toString()),
      new Decimal(0),
    );
    const statementAmount = subtract(
      transaction.debit.toString(),
      transaction.credit.toString(),
    );

    // Equal, not close. Matching unequal amounts would let somebody clear a
    // difference by declaring two unrelated figures to be the same thing.
    if (!entryAmount.equals(statementAmount)) {
      throw new BankAccountError(
        `That entry moves ${entryAmount.abs().toFixed(2)} on this account and the statement line is ${statementAmount.abs().toFixed(2)}. They have to agree.`,
        "AMOUNT_MISMATCH",
      );
    }

    await tx.bankTransaction.update({
      where: { id: transaction.id },
      data: { journalEntryId: entry.id, reconciledAt: new Date() },
    });

    return {
      bankTransactionId: transaction.id,
      entryNumber: entry.entryNumber,
    };
  });

  await recordAuditLog({
    action: "banking.matched",
    module: "Banking",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "BankTransaction",
    entityId: result.bankTransactionId,
    metadata: { entryNumber: result.entryNumber },
  });

  return result;
}

/** Breaks a link. The statement line and the entry both stay exactly as they were. */
export async function unmatchTransaction(params: {
  companyId: string;
  bankTransactionId: string;
  userId: string;
  actorEmail: string;
}): Promise<{ bankTransactionId: string }> {
  const transaction = await prisma.bankTransaction.findFirst({
    where: { id: params.bankTransactionId, companyId: params.companyId },
    select: { id: true, journalEntryId: true },
  });
  if (!transaction) {
    throw new BankAccountError(
      "That statement line does not belong to this business.",
      "NOT_FOUND",
    );
  }
  if (transaction.journalEntryId === null) {
    throw new BankAccountError("That line is not matched.", "NOT_MATCHED");
  }

  await prisma.bankTransaction.update({
    where: { id: transaction.id },
    data: { journalEntryId: null, reconciledAt: null },
  });

  await recordAuditLog({
    action: "banking.unmatched",
    module: "Banking",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "BankTransaction",
    entityId: transaction.id,
    metadata: { previousEntryId: transaction.journalEntryId },
  });

  return { bankTransactionId: transaction.id };
}
