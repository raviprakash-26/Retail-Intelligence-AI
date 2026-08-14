import "server-only";
import {
  JournalStatus,
  PartyType,
  type Prisma,
  type AccountNature,
  type AccountType,
  type VoucherType,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { signedBalance } from "@/lib/accounting/double-entry";
import {
  add,
  money,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";
import { describeSource, documentPath } from "./journal-service";

/**
 * One account, line by line, with a running balance.
 *
 * The ledger is the report a retailer actually recognises — the bahi khata,
 * the page per account with a balance carried down. Everything else in the
 * accounting module explains itself by reference to this.
 *
 * Two things make it harder than it looks, and both are handled here rather
 * than in the page.
 *
 * **The running balance has to survive pagination.** Row 26 of a cash ledger
 * shows the balance after twenty-six transactions, not after the one before it.
 * Recomputing from the top of each page would restart it at the opening figure
 * and every page after the first would be wrong — so the running total is
 * computed by the database across the whole ordered set and the page is taken
 * from that.
 *
 * **The order has to be total.** Two entries on the same day need a tiebreak,
 * or the running balance shuffles between page loads and two printouts of the
 * same ledger disagree. Date, then entry number, then line number: no two lines
 * can tie on all three.
 */

export type LedgerRow = {
  lineId: string;
  entryId: string;
  entryNumber: string;
  date: string;
  voucherType: VoucherType;
  narration: string | null;
  lineNarration: string | null;
  referenceNo: string | null;
  /** "Invoice", "Bill", … or null when somebody typed the entry. */
  source: string | null;
  /** Where the originating document lives, when there is one. */
  documentHref: string | null;
  partyName: string | null;
  debit: string;
  credit: string;
  /** Balance after this line, in the account's own direction. */
  running: string;
  /** Whether the entry this line belongs to has been reversed. */
  reversed: boolean;
};

export type LedgerAccount = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  nature: AccountNature;
  groupName: string;
  partyType: PartyType | null;
  isSystem: boolean;
};

export type AccountLedger = {
  account: LedgerAccount;
  from: string | null;
  to: string | null;
  /** Everything before the window, netted. */
  openingBalance: string;
  /** Movement inside the window. */
  periodDebit: string;
  periodCredit: string;
  closingBalance: string;
  rows: LedgerRow[];
  total: number;
  page: number;
  pageCount: number;
  /** The party the ledger was narrowed to, when it was. */
  party: { id: string; name: string } | null;
};

export const LEDGER_PAGE_SIZE = 50;

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Rows the ledger row-query returns, before any formatting. */
type RawLedgerRow = {
  line_id: string;
  entry_id: string;
  entry_number: string;
  entry_date: Date;
  voucher_type: VoucherType;
  narration: string | null;
  line_narration: string | null;
  reference_no: string | null;
  source_type: string | null;
  source_id: string | null;
  status: JournalStatus;
  party_id: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  running_debit: Prisma.Decimal;
  running_credit: Prisma.Decimal;
};

export async function getAccountLedger(params: {
  companyId: string;
  accountId: string;
  from?: string | null;
  to?: string | null;
  partyId?: string | null;
  page?: number;
}): Promise<AccountLedger> {
  const account = await prisma.account.findFirst({
    where: { id: params.accountId, companyId: params.companyId },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      nature: true,
      partyType: true,
      isSystem: true,
      group: { select: { name: true } },
    },
  });

  if (!account) {
    throw new LedgerError("That account could not be found.", "NOT_FOUND");
  }

  const from = params.from ? new Date(`${params.from}T00:00:00.000Z`) : null;
  const to = params.to ? new Date(`${params.to}T00:00:00.000Z`) : null;
  const page = Math.max(1, params.page ?? 1);
  const partyId = params.partyId || null;

  // A party filter is only meaningful on a control account; anywhere else the
  // lines carry no party and it would silently return nothing.
  if (partyId && !account.partyType) {
    throw new LedgerError(
      `${account.name} is not a control account, so its lines do not belong to anybody in particular.`,
      "NOT_A_CONTROL_ACCOUNT",
    );
  }

  const baseWhere: Prisma.JournalLineWhereInput = {
    companyId: params.companyId,
    accountId: account.id,
    status: JournalStatus.POSTED,
    ...(partyId ? { partyId } : {}),
  };

  const [openingTotals, periodTotals, total] = await Promise.all([
    // Everything before the window. Without a window start there is nothing
    // before it, so the opening is structurally nil.
    from
      ? prisma.journalLine.aggregate({
          where: { ...baseWhere, entryDate: { lt: from } },
          _sum: { debit: true, credit: true },
        })
      : Promise.resolve({ _sum: { debit: null, credit: null } }),
    prisma.journalLine.aggregate({
      where: {
        ...baseWhere,
        ...(from || to
          ? {
              entryDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      _sum: { debit: true, credit: true },
    }),
    prisma.journalLine.count({
      where: {
        ...baseWhere,
        ...(from || to
          ? {
              entryDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
    }),
  ]);

  const openingBalance = signedBalance(
    account.nature,
    openingTotals._sum.debit ?? 0,
    openingTotals._sum.credit ?? 0,
  );
  const periodDebit = money(periodTotals._sum.debit ?? 0);
  const periodCredit = money(periodTotals._sum.credit ?? 0);
  const closingBalance = add(
    openingBalance,
    signedBalance(account.nature, periodDebit, periodCredit),
  );

  const rows = await fetchRows({
    companyId: params.companyId,
    accountId: account.id,
    partyId,
    from,
    to,
    skip: (page - 1) * LEDGER_PAGE_SIZE,
    take: LEDGER_PAGE_SIZE,
  });

  const partyNames = await resolvePartyNames({
    companyId: params.companyId,
    partyType: account.partyType,
    ids: rows.map((row) => row.party_id).filter((id): id is string => !!id),
  });

  const party = partyId
    ? {
        id: partyId,
        name:
          (await resolvePartyNames({
            companyId: params.companyId,
            partyType: account.partyType,
            ids: [partyId],
          }).then((map) => map.get(partyId))) ?? "—",
      }
    : null;

  return {
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      nature: account.nature,
      groupName: account.group.name,
      partyType: account.partyType,
      isSystem: account.isSystem,
    },
    from: from ? isoDay(from) : null,
    to: to ? isoDay(to) : null,
    openingBalance: toStorageString(openingBalance),
    periodDebit: toStorageString(periodDebit),
    periodCredit: toStorageString(periodCredit),
    closingBalance: toStorageString(closingBalance),
    rows: rows.map((row) => ({
      lineId: row.line_id,
      entryId: row.entry_id,
      entryNumber: row.entry_number,
      date: isoDay(row.entry_date),
      voucherType: row.voucher_type,
      narration: row.narration,
      lineNarration: row.line_narration,
      referenceNo: row.reference_no,
      source: describeSource(row.source_type),
      documentHref: documentPath(row.source_type, row.source_id),
      partyName: row.party_id ? (partyNames.get(row.party_id) ?? null) : null,
      debit: toStorageString(row.debit),
      credit: toStorageString(row.credit),
      // The window function totals only what is inside the window, so the
      // balance carried in has to be added back on. With no window start the
      // opening is nil and this is the plain running total.
      running: toStorageString(
        add(
          openingBalance,
          signedBalance(account.nature, row.running_debit, row.running_credit),
        ),
      ),
      reversed: row.status === JournalStatus.REVERSED,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE)),
    party,
  };
}

/**
 * The lines themselves, with a running total the database computes.
 *
 * A window function rather than an accumulator in JavaScript, because the page
 * being asked for may start anywhere in the sequence and its first row still
 * has to show the balance after every line that precedes it. Summing only the
 * rows fetched would make page two of a ledger start again from zero.
 *
 * Written as raw SQL because Prisma has no window functions. Every value is a
 * bound parameter — nothing here is interpolated into the statement text.
 */
async function fetchRows(params: {
  companyId: string;
  accountId: string;
  partyId: string | null;
  from: Date | null;
  to: Date | null;
  skip: number;
  take: number;
}): Promise<RawLedgerRow[]> {
  const { companyId, accountId, partyId, from, to, skip, take } = params;

  return prisma.$queryRaw<RawLedgerRow[]>`
    SELECT
      line_id, entry_id, entry_number, entry_date, voucher_type,
      narration, line_narration, reference_no, source_type, source_id,
      status, party_id, debit, credit, running_debit, running_credit
    FROM (
      SELECT
        l.id                AS line_id,
        e.id                AS entry_id,
        e."entryNumber"     AS entry_number,
        l."entryDate"       AS entry_date,
        e."voucherType"     AS voucher_type,
        e.narration         AS narration,
        l.narration         AS line_narration,
        e."referenceNo"     AS reference_no,
        e."sourceType"      AS source_type,
        e."sourceId"        AS source_id,
        e.status            AS status,
        l."partyId"         AS party_id,
        l.debit             AS debit,
        l.credit            AS credit,
        SUM(l.debit) OVER w  AS running_debit,
        SUM(l.credit) OVER w AS running_credit,
        ROW_NUMBER() OVER w  AS ordinal
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l."journalEntryId"
      WHERE l."companyId" = ${companyId}::uuid
        AND l."accountId" = ${accountId}::uuid
        AND l.status = 'POSTED'
        AND (${partyId}::uuid IS NULL OR l."partyId" = ${partyId}::uuid)
        AND (${from}::date IS NULL OR l."entryDate" >= ${from}::date)
        AND (${to}::date IS NULL OR l."entryDate" <= ${to}::date)
      WINDOW w AS (
        ORDER BY l."entryDate", e."entryNumber", l."lineNumber"
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      )
    ) ordered
    ORDER BY ordinal
    OFFSET ${skip}
    LIMIT ${take}
  `;
}

async function resolvePartyNames(params: {
  companyId: string;
  partyType: PartyType | null;
  ids: string[];
}): Promise<Map<string, string>> {
  const ids = [...new Set(params.ids)];
  if (ids.length === 0 || !params.partyType) return new Map();

  const rows =
    params.partyType === PartyType.CUSTOMER
      ? await prisma.customer.findMany({
          where: { companyId: params.companyId, id: { in: ids } },
          select: { id: true, name: true },
        })
      : params.partyType === PartyType.SUPPLIER
        ? await prisma.supplier.findMany({
            where: { companyId: params.companyId, id: { in: ids } },
            select: { id: true, name: true },
          })
        : [];

  return new Map(rows.map((row) => [row.id, row.name]));
}

// ---------------------------------------------------------------------------
// Choosing what to look at
// ---------------------------------------------------------------------------

export type LedgerAccountOption = {
  id: string;
  code: string;
  name: string;
  groupName: string;
  type: AccountType;
  partyType: PartyType | null;
  /** Whether anything has ever been posted to it. */
  used: boolean;
};

/**
 * Accounts worth opening a ledger on.
 *
 * Retired accounts are included when they still carry history — an account put
 * away in March is exactly the one somebody wants to look at in June, and
 * hiding it would make last year's figures unexplainable.
 */
export async function ledgerAccounts(
  companyId: string,
): Promise<LedgerAccountOption[]> {
  const [accounts, used] = await Promise.all([
    prisma.account.findMany({
      where: { companyId },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        partyType: true,
        isActive: true,
        group: { select: { name: true } },
      },
      orderBy: { code: "asc" },
    }),
    prisma.journalLine.groupBy({
      by: ["accountId"],
      where: { companyId, status: JournalStatus.POSTED },
      _count: { _all: true },
    }),
  ]);

  const withHistory = new Set(used.map((row) => row.accountId));

  return accounts
    .filter((account) => account.isActive || withHistory.has(account.id))
    .map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
      groupName: account.group.name,
      type: account.type,
      partyType: account.partyType,
      used: withHistory.has(account.id),
    }));
}

/** Customers or suppliers with movement on a control account. */
export async function ledgerParties(params: {
  companyId: string;
  partyType: PartyType;
}): Promise<Array<{ id: string; name: string }>> {
  const where = { companyId: params.companyId, archivedAt: null };
  const select = { id: true, name: true };
  const orderBy = { name: "asc" } as const;

  return params.partyType === PartyType.CUSTOMER
    ? prisma.customer.findMany({ where, select, orderBy, take: 500 })
    : prisma.supplier.findMany({ where, select, orderBy, take: 500 });
}

/**
 * A party's statement: what they owe, and how it got that way.
 *
 * The same ledger, narrowed to one name on the control account. This is the
 * document a retailer actually sends a customer who disputes a balance, so it
 * has to reconcile exactly with the ageing report — and it does, because both
 * are derived from the same posted lines rather than from separate totals.
 */
export async function partyStatement(params: {
  companyId: string;
  partyType: PartyType;
  partyId: string;
  from?: string | null;
  to?: string | null;
  page?: number;
}): Promise<AccountLedger> {
  const systemKey =
    params.partyType === PartyType.CUSTOMER
      ? "ACCOUNTS_RECEIVABLE"
      : "ACCOUNTS_PAYABLE";

  const account = await prisma.account.findFirst({
    where: { companyId: params.companyId, systemKey },
    select: { id: true },
  });

  if (!account) {
    throw new LedgerError(
      "This business has no control account for that party type.",
      "NO_CONTROL_ACCOUNT",
    );
  }

  return getAccountLedger({
    companyId: params.companyId,
    accountId: account.id,
    partyId: params.partyId,
    from: params.from,
    to: params.to,
    page: params.page,
  });
}

/**
 * How the closing balance should be read aloud.
 *
 * "₹1,180 Dr" means nothing to a shopkeeper; "Sharma Provision Store owes you
 * ₹1,180" does. The wording depends on which side the balance is on and what
 * kind of account it is, so it is decided once here rather than in each view.
 */
export function describeBalance(params: {
  type: AccountType;
  nature: AccountNature;
  balance: Decimal | string;
  partyName?: string | null;
}): string {
  const value = money(params.balance);
  if (value.isZero()) return "Nothing outstanding";

  const negative = value.isNegative();
  const who = params.partyName ?? "This account";

  if (params.type === "ASSET" && params.nature === "DEBIT") {
    if (params.partyName) {
      return negative
        ? `${who} is in credit with you`
        : `${who} owes you this much`;
    }
    return negative ? "Overdrawn" : "Held";
  }
  if (params.type === "LIABILITY") {
    if (params.partyName) {
      return negative
        ? `You are in credit with ${who}`
        : `You owe ${who} this much`;
    }
    return negative ? "Overpaid" : "Owed";
  }
  if (params.type === "INCOME") return negative ? "Net of returns" : "Earned";
  if (params.type === "EXPENSE") return negative ? "Net of credits" : "Spent";
  return negative ? "Reduced" : "Your stake";
}

/** Debit or credit, for the side a balance actually sits on. */
export function balanceSideLabel(balance: Decimal | string): "Dr" | "Cr" | "" {
  const value = money(balance);
  if (value.isZero()) return "";
  return value.isNegative() ? "Cr" : "Dr";
}

/**
 * Whether opening plus movement really is the closing figure.
 *
 * Trivially true given how the three are derived, which is the point: it is
 * cheap, and if it ever fails the ledger is lying rather than merely being
 * inconvenient. Worth asserting in tests, and worth the page being able to say
 * so plainly.
 */
export function ledgerReconciles(ledger: AccountLedger): boolean {
  const expected = add(
    money(ledger.openingBalance),
    signedBalance(
      ledger.account.nature,
      ledger.periodDebit,
      ledger.periodCredit,
    ),
  );
  return subtract(expected, money(ledger.closingBalance)).isZero();
}
