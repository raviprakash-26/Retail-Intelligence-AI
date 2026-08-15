import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { toStorageString } from "@/lib/money";
import {
  parseBankStatement,
  type ParsedStatementRow,
  type StatementRowError,
} from "@/lib/banking/statement-parser";
import { recordAuditLog } from "@/server/audit/audit-log";
import { BankAccountError } from "./bank-account-service";

/**
 * Importing a bank statement.
 *
 * The property that matters most here is that importing the same statement
 * twice does nothing the second time. People re-download statements with
 * overlapping date ranges constantly — April, then April-to-June — and an
 * importer that appends blindly would double every transaction in the overlap
 * and produce a reconciliation that is wrong by exactly the amount somebody is
 * trying to find.
 *
 * So each row gets a fingerprint of the things that identify it, and a row
 * whose fingerprint is already present for that bank account is skipped and
 * counted rather than inserted.
 */

export type ImportSummary = {
  batchId: string;
  imported: number;
  duplicates: number;
  /** Rows the parser could not read, by line number. */
  skipped: StatementRowError[];
  firstDate: Date | null;
  lastDate: Date | null;
};

/**
 * What makes a statement line the same line.
 *
 * Date, direction, amount, reference and description together. Not the running
 * balance — that shifts if the bank re-orders same-day transactions between two
 * exports, and a fingerprint that changes for the same underlying transaction
 * is a fingerprint that fails to deduplicate.
 *
 * Two genuinely identical transactions on one day (two ₹500 cash withdrawals,
 * same description, no reference) will collide. That is a real limitation and
 * it is the safer direction to be wrong in: under-importing shows up as an
 * unexplained difference somebody investigates, while over-importing shows up
 * as a reconciliation that quietly balances against a doubled figure. The
 * import result names the count, so the second one is visible rather than
 * silent.
 */
export function fingerprintRow(
  bankAccountId: string,
  row: Pick<
    ParsedStatementRow,
    "txnDate" | "direction" | "amount" | "referenceNo" | "description"
  >,
): string {
  const parts = [
    bankAccountId,
    row.txnDate.toISOString().slice(0, 10),
    row.direction,
    toStorageString(row.amount),
    row.referenceNo ?? "",
    row.description.replace(/\s+/g, " ").trim().toLowerCase(),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export async function importStatement(params: {
  companyId: string;
  bankAccountId: string;
  content: string;
  fileName?: string | undefined;
  userId: string;
  actorEmail: string;
}): Promise<ImportSummary> {
  const bankAccount = await prisma.bankAccount.findFirst({
    where: { id: params.bankAccountId, companyId: params.companyId },
    select: { id: true, name: true },
  });
  if (!bankAccount) {
    throw new BankAccountError(
      "That bank account does not belong to this business.",
      "NOT_FOUND",
      "bankAccountId",
    );
  }

  // Throws StatementFormatError for a file that is not a statement at all;
  // per-row problems come back as errors rather than stopping the import.
  const parsed = parseBankStatement(params.content);

  const batchId = randomUUID();
  const fingerprints = parsed.rows.map((row) =>
    fingerprintRow(bankAccount.id, row),
  );

  const summary = await prisma.$transaction(async (tx) => {
    // Existing fingerprints for this account, in one query rather than one per
    // row: a year of statements is a few thousand rows and a round trip each
    // would hold the transaction open for minutes.
    const existing = await tx.bankTransaction.findMany({
      where: { companyId: params.companyId, bankAccountId: bankAccount.id },
      select: { fingerprint: true },
    });
    const seen = new Set(existing.map((entry) => entry.fingerprint));

    const toCreate: {
      row: ParsedStatementRow;
      fingerprint: string;
    }[] = [];
    let duplicates = 0;

    for (let index = 0; index < parsed.rows.length; index += 1) {
      const fingerprint = fingerprints[index]!;
      // `seen` is updated as we go, so a file that repeats a row inside itself
      // is deduplicated too, not only against what was imported before.
      if (seen.has(fingerprint)) {
        duplicates += 1;
        continue;
      }
      seen.add(fingerprint);
      toCreate.push({ row: parsed.rows[index]!, fingerprint });
    }

    let inserted = 0;
    if (toCreate.length > 0) {
      // `skipDuplicates` leans on the unique index rather than on the check
      // above. The check is still worth doing — it is what makes the reported
      // duplicate count meaningful — but it cannot be the only defence: two
      // uploads racing would both read an empty set and both write.
      const result = await tx.bankTransaction.createMany({
        skipDuplicates: true,
        data: toCreate.map(({ row, fingerprint }) => ({
          companyId: params.companyId,
          bankAccountId: bankAccount.id,
          txnDate: row.txnDate,
          valueDate: row.valueDate,
          description: row.description,
          referenceNo: row.referenceNo,
          // Stored from our books' point of view, not the bank's: money
          // arriving debits the bank asset. The parser has already flipped the
          // bank's own column headings to get here.
          debit: toStorageString(row.direction === "IN" ? row.amount : 0),
          credit: toStorageString(row.direction === "OUT" ? row.amount : 0),
          runningBalance:
            row.runningBalance === null
              ? null
              : toStorageString(row.runningBalance),
          importBatchId: batchId,
          fingerprint,
        })),
      });
      inserted = result.count;
      // Anything the index rejected was a duplicate the pre-check missed.
      duplicates += toCreate.length - inserted;
    }

    const dates = toCreate.map(({ row }) => row.txnDate.getTime());
    return {
      batchId,
      imported: inserted,
      duplicates,
      skipped: parsed.errors,
      firstDate: dates.length > 0 ? new Date(Math.min(...dates)) : null,
      lastDate: dates.length > 0 ? new Date(Math.max(...dates)) : null,
    } satisfies ImportSummary;
  });

  await recordAuditLog({
    action: "banking.statement_imported",
    module: "Banking",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "BankAccount",
    entityId: bankAccount.id,
    metadata: {
      batchId: summary.batchId,
      fileName: params.fileName ?? null,
      imported: summary.imported,
      duplicatesSkipped: summary.duplicates,
      unreadableRows: summary.skipped.length,
    },
  });

  return summary;
}
