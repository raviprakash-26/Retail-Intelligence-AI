import "server-only";
import {
  JournalStatus,
  PartyType,
  Prisma,
  type VoucherType,
  type AccountNature,
  type AccountType,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import type { DraftJournalLine } from "@/lib/accounting/double-entry";
import { add, compare, money, subtract, toStorageString } from "@/lib/money";
import type { JournalEntryInput } from "@/lib/validation/journal";
import { recordAuditLog } from "@/server/audit/audit-log";
import { reversePostedEntry } from "@/server/documents/reversal";
import {
  STATEMENT_POSTING_SOURCE,
  STATEMENT_POSTING_REVERSAL_SOURCE,
} from "@/server/banking/record-from-statement";
import { postJournalEntry } from "./post-journal-entry";

/**
 * The journal — every entry the books contain, and the few a person posts by
 * hand.
 *
 * Most entries here were produced by a document. That is the right way round:
 * the transaction is the fact, and the entry follows from it. The journal is
 * where they can all be read in one place, which is the first thing an auditor
 * asks for and the last thing most retail software provides.
 *
 * A manual entry is the exception, and it is fenced deliberately.
 *
 * **A document's entry is never voided from here.** Reversing the entry behind
 * an invoice without touching the invoice would leave the sale standing in the
 * sales register with no accounting behind it — the two would disagree and
 * neither would be obviously wrong. Void the invoice; its entry follows.
 *
 * **A control account needs a party.** Posting to Accounts Receivable without
 * saying whose debt it is creates a receivable nobody can chase, age or settle;
 * it just inflates the total and quietly makes the ageing report a lie. A bad
 * debt write-off is a real and necessary entry, so it is allowed — attributed.
 *
 * **A manual entry is marked as one.** `isSystem` stays false and the voucher
 * type is restricted, so the audit trail can always tell an entry somebody
 * typed from one the system derived.
 */

export const JOURNAL_AUDIT = {
  POSTED: "journal.posted",
  REVERSED: "journal.reversed",
} as const;

export const MANUAL_SOURCE_TYPE = "MANUAL_JOURNAL";
export const MANUAL_REVERSAL_SOURCE = "MANUAL_JOURNAL_REVERSAL";

export class JournalError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "JournalError";
  }
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

type AccountForPosting = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  partyType: PartyType | null;
};

/**
 * Checks each line against the account it names, inside the transaction.
 *
 * Balance and shape are already settled by the schema; what is left is whether
 * these particular accounts may be posted to at all, which only the database
 * knows.
 */
async function resolveLines(
  tx: Prisma.TransactionClient,
  params: { companyId: string; input: JournalEntryInput },
): Promise<DraftJournalLine[]> {
  const ids = [...new Set(params.input.lines.map((line) => line.accountId))];

  const accounts = await tx.account.findMany({
    where: { companyId: params.companyId, id: { in: ids } },
    select: {
      id: true,
      code: true,
      name: true,
      isActive: true,
      partyType: true,
    },
  });

  const byId = new Map<string, AccountForPosting>(
    accounts.map((account) => [account.id, account]),
  );

  const lines: DraftJournalLine[] = [];

  for (const [index, line] of params.input.lines.entries()) {
    const account = byId.get(line.accountId);
    if (!account) {
      throw new JournalError(
        `Line ${index + 1} names an account that does not exist in your chart.`,
        "ACCOUNT_NOT_FOUND",
        `lines.${index}.accountId`,
      );
    }
    if (!account.isActive) {
      throw new JournalError(
        `${account.name} has been put away. Bring it back before posting to it.`,
        "ACCOUNT_INACTIVE",
        `lines.${index}.accountId`,
      );
    }

    let partyId: string | null = null;

    if (account.partyType) {
      if (!line.partyId) {
        throw new JournalError(
          `${account.name} is a control account, so line ${index + 1} has to say whose balance it moves. A receivable that belongs to nobody can never be chased or settled.`,
          "PARTY_REQUIRED",
          `lines.${index}.partyId`,
        );
      }

      const exists =
        account.partyType === PartyType.CUSTOMER
          ? await tx.customer.findFirst({
              where: { id: line.partyId, companyId: params.companyId },
              select: { id: true },
            })
          : await tx.supplier.findFirst({
              where: { id: line.partyId, companyId: params.companyId },
              select: { id: true },
            });

      if (!exists) {
        throw new JournalError(
          `Line ${index + 1} names someone who is not in your records.`,
          "PARTY_NOT_FOUND",
          `lines.${index}.partyId`,
        );
      }
      partyId = line.partyId;
    }

    lines.push({
      accountId: account.id,
      debit: line.debit,
      credit: line.credit,
      narration: line.narration || null,
      partyType: account.partyType,
      partyId,
    });
  }

  return lines;
}

export type PostedManualEntry = {
  id: string;
  entryNumber: string;
  total: string;
};

export async function createManualEntry(params: {
  companyId: string;
  branchId: string | null;
  userId: string;
  actorEmail: string;
  input: JournalEntryInput;
}): Promise<PostedManualEntry> {
  const { companyId, input } = params;

  return prisma.$transaction(async (tx) => {
    const entryDate = new Date(`${input.entryDate}T00:00:00.000Z`);
    const lines = await resolveLines(tx, { companyId, input });

    const total = add(...lines.map((line) => line.debit ?? 0));

    const entry = await postJournalEntry(tx, {
      companyId,
      branchId: params.branchId,
      entryDate,
      voucherType: input.voucherType as VoucherType,
      narration: input.narration,
      referenceNo: input.referenceNo || null,
      sourceType: MANUAL_SOURCE_TYPE,
      createdById: params.userId,
      // Typed by a person, not derived by the system. The distinction is what
      // lets an audit separate judgement from arithmetic.
      isSystem: false,
      lines,
    });

    await recordAuditLog(
      {
        action: JOURNAL_AUDIT.POSTED,
        module: "Accounting",
        companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "JournalEntry",
        entityId: entry.id,
        metadata: {
          entryNumber: entry.entryNumber,
          voucherType: input.voucherType,
          narration: input.narration,
          total: toStorageString(total),
          lines: lines.length,
        },
      },
      tx,
    );

    return {
      id: entry.id,
      entryNumber: entry.entryNumber,
      total: toStorageString(total),
    };
  });
}

// ---------------------------------------------------------------------------
// Reversing
// ---------------------------------------------------------------------------

/**
 * Reverses a manual entry.
 *
 * Only a manual one. An entry that came from a document is undone by voiding
 * the document, which reverses the entry as part of the same transaction and
 * puts the stock, the allocations and the registers back at the same time.
 * Reversing it from here would do the accounting half and leave the rest.
 */
export async function reverseManualEntry(params: {
  companyId: string;
  entryId: string;
  userId: string;
  actorEmail: string;
  reason: string;
}): Promise<{ entryNumber: string }> {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.findFirst({
      where: { id: params.entryId, companyId: params.companyId },
      select: {
        id: true,
        entryNumber: true,
        entryDate: true,
        branchId: true,
        voucherType: true,
        status: true,
        sourceType: true,
        totalDebit: true,
      },
    });

    if (!entry) {
      throw new JournalError("That entry could not be found.", "NOT_FOUND");
    }
    if (entry.status !== JournalStatus.POSTED) {
      throw new JournalError(
        entry.status === JournalStatus.REVERSED
          ? "This entry has already been reversed."
          : "Only a posted entry can be reversed.",
        "NOT_POSTED",
      );
    }
    if (entry.sourceType !== MANUAL_SOURCE_TYPE) {
      throw new JournalError(
        "This entry came from a document. Void the document instead — that reverses the entry and puts back the stock and settlements that went with it.",
        "DOCUMENT_ENTRY",
      );
    }

    const reversal = await reversePostedEntry(tx, {
      companyId: params.companyId,
      entryId: entry.id,
      branchId: entry.branchId,
      entryDate: entry.entryDate,
      voucherType: entry.voucherType,
      narration: `Reversal of ${entry.entryNumber} — ${params.reason}`,
      referenceNo: entry.entryNumber,
      sourceType: MANUAL_REVERSAL_SOURCE,
      sourceId: entry.id,
      createdById: params.userId,
    });

    await recordAuditLog(
      {
        action: JOURNAL_AUDIT.REVERSED,
        module: "Accounting",
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "JournalEntry",
        entityId: entry.id,
        metadata: {
          entryNumber: entry.entryNumber,
          reversalEntry: reversal.entryNumber,
          total: toStorageString(entry.totalDebit),
          reason: params.reason,
        },
      },
      tx,
    );

    return { entryNumber: reversal.entryNumber };
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const JOURNAL_PAGE_SIZE = 25;

export type JournalRow = {
  id: string;
  entryNumber: string;
  date: string;
  voucherType: VoucherType;
  narration: string | null;
  referenceNo: string | null;
  status: JournalStatus;
  total: string;
  lineCount: number;
  /** Null for a manual entry; the module name for a derived one. */
  source: string | null;
  isSystem: boolean;
};

export type JournalListResult = {
  rows: JournalRow[];
  total: number;
  page: number;
  pageCount: number;
  /** Totals across the whole filtered set, not just this page. */
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
};

/** What produced an entry, in words rather than a source-type constant. */
const SOURCE_LABELS: Record<string, string> = {
  SALE: "Invoice",
  SALE_VOID: "Invoice void",
  PURCHASE: "Bill",
  PURCHASE_VOID: "Bill void",
  EXPENSE: "Expense",
  EXPENSE_VOID: "Expense void",
  RECEIPT: "Receipt",
  RECEIPT_VOID: "Receipt void",
  PAYMENT: "Payment",
  PAYMENT_VOID: "Payment void",
  OPENING_BALANCE: "Opening balance",
  [MANUAL_REVERSAL_SOURCE]: "Reversal",
  // Without these two the journal shows a table name and a shouted constant to
  // somebody reading their own ledger.
  [STATEMENT_POSTING_SOURCE]: "Bank statement",
  [STATEMENT_POSTING_REVERSAL_SOURCE]: "Bank statement reversal",
};

export function describeSource(sourceType: string | null): string | null {
  if (!sourceType || sourceType === MANUAL_SOURCE_TYPE) return null;
  return SOURCE_LABELS[sourceType] ?? sourceType;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export type JournalFilters = {
  companyId: string;
  query?: string;
  voucherType?: string;
  accountId?: string;
  from?: string;
  to?: string;
  /** Only entries somebody typed, or only ones the system derived. */
  origin?: "manual" | "system";
  page?: number;
};

function buildWhere(filters: JournalFilters): Prisma.JournalEntryWhereInput {
  const query = filters.query?.trim() ?? "";

  return {
    companyId: filters.companyId,
    ...(filters.voucherType
      ? { voucherType: filters.voucherType as VoucherType }
      : {}),
    ...(filters.from || filters.to
      ? {
          entryDate: {
            ...(filters.from
              ? { gte: new Date(`${filters.from}T00:00:00.000Z`) }
              : {}),
            ...(filters.to
              ? { lte: new Date(`${filters.to}T00:00:00.000Z`) }
              : {}),
          },
        }
      : {}),
    ...(filters.origin === "manual"
      ? { sourceType: MANUAL_SOURCE_TYPE }
      : filters.origin === "system"
        ? { NOT: { sourceType: MANUAL_SOURCE_TYPE } }
        : {}),
    ...(filters.accountId
      ? { lines: { some: { accountId: filters.accountId } } }
      : {}),
    ...(query.length >= 1
      ? {
          OR: [
            {
              entryNumber: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              narration: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              referenceNo: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
          ],
        }
      : {}),
  };
}

/**
 * The journal register.
 *
 * The debit and credit totals are across the whole filtered set rather than the
 * page, because "do these entries balance" is a question about the set. A total
 * that only covered twenty-five rows would answer a question nobody asked.
 */
export async function listJournalEntries(
  filters: JournalFilters,
): Promise<JournalListResult> {
  const page = Math.max(1, filters.page ?? 1);
  const where = buildWhere(filters);

  const [total, entries, sums] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findMany({
      where,
      select: {
        id: true,
        entryNumber: true,
        entryDate: true,
        voucherType: true,
        narration: true,
        referenceNo: true,
        status: true,
        totalDebit: true,
        sourceType: true,
        isSystem: true,
        _count: { select: { lines: true } },
      },
      orderBy: [{ entryDate: "desc" }, { entryNumber: "desc" }],
      skip: (page - 1) * JOURNAL_PAGE_SIZE,
      take: JOURNAL_PAGE_SIZE,
    }),
    prisma.journalEntry.aggregate({
      where,
      _sum: { totalDebit: true, totalCredit: true },
    }),
  ]);

  const totalDebit = money(sums._sum.totalDebit ?? 0);
  const totalCredit = money(sums._sum.totalCredit ?? 0);

  return {
    rows: entries.map((entry) => ({
      id: entry.id,
      entryNumber: entry.entryNumber,
      date: isoDay(entry.entryDate),
      voucherType: entry.voucherType,
      narration: entry.narration,
      referenceNo: entry.referenceNo,
      status: entry.status,
      total: toStorageString(entry.totalDebit),
      lineCount: entry._count.lines,
      source: describeSource(entry.sourceType),
      isSystem: entry.isSystem,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / JOURNAL_PAGE_SIZE)),
    totalDebit: toStorageString(totalDebit),
    totalCredit: toStorageString(totalCredit),
    balanced: compare(subtract(totalDebit, totalCredit), 0) === 0,
  };
}

export type JournalEntryDetail = {
  id: string;
  entryNumber: string;
  date: string;
  voucherType: VoucherType;
  narration: string | null;
  referenceNo: string | null;
  status: JournalStatus;
  total: string;
  source: string | null;
  sourceType: string | null;
  sourceId: string | null;
  isSystem: boolean;
  isManual: boolean;
  postedAt: Date | null;
  branchName: string | null;
  periodStatus: string | null;
  lines: Array<{
    lineNumber: number;
    debit: string;
    credit: string;
    narration: string | null;
    account: {
      id: string;
      code: string;
      name: string;
      type: AccountType;
      nature: AccountNature;
    };
    partyName: string | null;
  }>;
  /** The entry this one reverses, or the one that reversed it. */
  reverses: { id: string; entryNumber: string } | null;
  reversedBy: { id: string; entryNumber: string } | null;
};

export async function getJournalEntry(params: {
  companyId: string;
  entryId: string;
}): Promise<JournalEntryDetail> {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: params.entryId, companyId: params.companyId },
    select: {
      id: true,
      entryNumber: true,
      entryDate: true,
      voucherType: true,
      narration: true,
      referenceNo: true,
      status: true,
      totalDebit: true,
      sourceType: true,
      sourceId: true,
      isSystem: true,
      postedAt: true,
      branch: { select: { name: true } },
      fiscalPeriod: { select: { status: true } },
      reverses: { select: { id: true, entryNumber: true } },
      reversedBy: { select: { id: true, entryNumber: true } },
      lines: {
        select: {
          lineNumber: true,
          debit: true,
          credit: true,
          narration: true,
          partyType: true,
          partyId: true,
          account: {
            select: {
              id: true,
              code: true,
              name: true,
              type: true,
              nature: true,
            },
          },
        },
        orderBy: { lineNumber: "asc" },
      },
    },
  });

  if (!entry) {
    throw new JournalError("That entry could not be found.", "NOT_FOUND");
  }

  // Party names in one round trip rather than one per line.
  const customerIds = entry.lines
    .filter((line) => line.partyType === PartyType.CUSTOMER && line.partyId)
    .map((line) => line.partyId!);
  const supplierIds = entry.lines
    .filter((line) => line.partyType === PartyType.SUPPLIER && line.partyId)
    .map((line) => line.partyId!);

  const [customers, suppliers] = await Promise.all([
    customerIds.length
      ? prisma.customer.findMany({
          where: { companyId: params.companyId, id: { in: customerIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    supplierIds.length
      ? prisma.supplier.findMany({
          where: { companyId: params.companyId, id: { in: supplierIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const partyNames = new Map<string, string>([
    ...customers.map((entry_) => [entry_.id, entry_.name] as const),
    ...suppliers.map((entry_) => [entry_.id, entry_.name] as const),
  ]);

  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    date: isoDay(entry.entryDate),
    voucherType: entry.voucherType,
    narration: entry.narration,
    referenceNo: entry.referenceNo,
    status: entry.status,
    total: toStorageString(entry.totalDebit),
    source: describeSource(entry.sourceType),
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    isSystem: entry.isSystem,
    isManual: entry.sourceType === MANUAL_SOURCE_TYPE,
    postedAt: entry.postedAt,
    branchName: entry.branch?.name ?? null,
    periodStatus: entry.fiscalPeriod?.status ?? null,
    lines: entry.lines.map((line) => ({
      lineNumber: line.lineNumber,
      debit: toStorageString(line.debit),
      credit: toStorageString(line.credit),
      narration: line.narration,
      account: line.account,
      partyName: line.partyId ? (partyNames.get(line.partyId) ?? null) : null,
    })),
    reverses: entry.reverses,
    reversedBy: entry.reversedBy,
  };
}

/**
 * Where a document's entry lives, so the detail page can link back to it.
 *
 * Returned as a path rather than a component decision, because the journal
 * should not have to know how each module lays out its routes beyond this one
 * table.
 */
export function documentPath(
  sourceType: string | null,
  sourceId: string | null,
): string | null {
  if (!sourceType || !sourceId) return null;

  const base: Record<string, string> = {
    SALE: "/app/sales",
    SALE_VOID: "/app/sales",
    PURCHASE: "/app/purchases",
    PURCHASE_VOID: "/app/purchases",
    EXPENSE: "/app/expenses",
    EXPENSE_VOID: "/app/expenses",
    RECEIPT: "/app/receipts",
    RECEIPT_VOID: "/app/receipts",
    PAYMENT: "/app/payments",
    PAYMENT_VOID: "/app/payments",
  };

  const path = base[sourceType];
  return path ? `${path}/${sourceId}` : null;
}

/** Accounts a manual entry may post to, with what they hold now. */
export async function postableAccounts(companyId: string): Promise<
  Array<{
    id: string;
    code: string;
    name: string;
    type: AccountType;
    /** Set when the account needs a party on every line. */
    partyType: PartyType | null;
    groupName: string;
  }>
> {
  const accounts = await prisma.account.findMany({
    where: { companyId, isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      partyType: true,
      group: { select: { name: true } },
    },
    orderBy: { code: "asc" },
  });

  return accounts.map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    partyType: account.partyType,
    groupName: account.group.name,
  }));
}
