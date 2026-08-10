import "server-only";
import { AccountNature, VoucherType, type PartyType } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  abs,
  isNegative,
  isZero,
  money,
  multiply,
  subtract,
  toStorageString,
  type Decimal,
  type MoneyInput,
} from "@/lib/money";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";

/**
 * Opening balances.
 *
 * A business that migrates onto this platform mid-life arrives owing money and
 * being owed it, with stock on the shelves. Those positions have to enter the
 * ledger as *balanced entries*, not as numbers stored beside the master record
 * — otherwise the trial balance is wrong from the first day and every statement
 * built on it inherits the error.
 *
 * The counter-side is the owner's capital account. On migration that is exactly
 * what capital means: what the business owns minus what it owes. Using a
 * suspense account instead would leave a balance the retailer is expected to
 * clear later, and in practice nobody ever does.
 *
 * Nothing here writes `account.openingBalance`. That column is a display
 * convenience; the journal is the single source of financial truth, and keeping
 * a second running total in sync as parties are added one at a time is a drift
 * risk with no upside.
 */

export const OPENING_SOURCE = {
  CUSTOMER: "CUSTOMER_OPENING",
  SUPPLIER: "SUPPLIER_OPENING",
  PRODUCT: "PRODUCT_OPENING",
} as const;

export type OpeningSource = (typeof OPENING_SOURCE)[keyof typeof OPENING_SOURCE];

export class OpeningBalanceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "OpeningBalanceError";
  }
}

/**
 * The net *debit* an opening position represents on its control account.
 *
 * One convention covers both sides of the business: a customer who owes us
 * ₹50,000 is a debit on receivables; a supplier we owe ₹30,000 is a credit on
 * payables, which is a debit of −30,000. Expressing both as a signed debit
 * means a single posting routine handles every case, including the awkward ones
 * — a customer in credit, a supplier we have paid in advance.
 */
export function signedOpening(
  balance: MoneyInput,
  nature: AccountNature,
): Decimal {
  const amount = money(balance);
  return nature === AccountNature.DEBIT ? amount : amount.negated();
}

/** Opening stock is always a debit to inventory: quantity × cost per unit. */
export function openingStockValue(
  quantity: MoneyInput,
  rate: MoneyInput,
): Decimal {
  return multiply(quantity, rate);
}

export type OpeningContext = {
  /** First day of the current financial year — where opening positions sit. */
  date: Date;
  fiscalYearLabel: string;
  branchId: string | null;
  capitalAccountId: string;
};

/**
 * Resolves everything an opening entry needs, and fails loudly if it cannot.
 *
 * Called before any master record is written so a company with no financial
 * year is refused before it has half-created a customer.
 */
export async function resolveOpeningContext(
  tx: DbClient,
  companyId: string,
): Promise<OpeningContext> {
  const [fiscalYear, branch, capital] = await Promise.all([
    tx.fiscalYear.findFirst({
      where: { companyId, isCurrent: true },
      select: { startDate: true, label: true },
    }),
    tx.branch.findFirst({
      where: { companyId, isPrimary: true },
      select: { id: true },
    }),
    tx.account.findFirst({
      where: { companyId, systemKey: SYSTEM_ACCOUNT.OWNER_CAPITAL },
      select: { id: true },
    }),
  ]);

  if (!fiscalYear) {
    throw new OpeningBalanceError(
      "This business has no current financial year, so an opening balance has nowhere to post.",
      "NO_FISCAL_YEAR",
    );
  }
  if (!capital) {
    throw new OpeningBalanceError(
      "The owner's capital account is missing from the chart of accounts.",
      "NO_CAPITAL_ACCOUNT",
    );
  }

  return {
    date: fiscalYear.startDate,
    fiscalYearLabel: fiscalYear.label,
    branchId: branch?.id ?? null,
    capitalAccountId: capital.id,
  };
}

export async function resolveSystemAccountId(
  tx: DbClient,
  companyId: string,
  systemKey: string,
): Promise<string> {
  const account = await tx.account.findFirst({
    where: { companyId, systemKey },
    select: { id: true },
  });
  if (!account) {
    throw new OpeningBalanceError(
      `The ${systemKey.toLowerCase().replace(/_/g, " ")} account is missing from the chart of accounts.`,
      "NO_ACCOUNT",
    );
  }
  return account.id;
}

/**
 * Posts the difference between two opening positions.
 *
 * Editing an opening balance never rewrites the original entry — posted history
 * is immutable, and the database enforces that regardless of what this code
 * intends. Instead the change is expressed as its own balanced entry for the
 * delta, dated alongside the original, so the ledger shows both what was first
 * recorded and what it was corrected to.
 *
 * Returns null when there is nothing to post, which is the common case: most
 * edits change a phone number, not a balance.
 */
export async function postOpeningDelta(
  tx: DbClient,
  params: {
    companyId: string;
    context: OpeningContext;
    /** Control account for this kind of position — receivables, payables, stock. */
    accountId: string;
    partyType?: PartyType | null;
    partyId?: string | null;
    source: OpeningSource;
    sourceId: string;
    /** Signed debit the position should now represent. */
    target: MoneyInput;
    /** Signed debit already posted for it. Zero for a new record. */
    posted: MoneyInput;
    narration: string;
    createdById: string | null;
  },
): Promise<{ entryNumber: string; delta: string } | null> {
  const delta = subtract(params.target, params.posted);
  if (isZero(delta)) return null;

  const magnitude = abs(delta);
  // A negative delta means the control account must be credited: either the
  // position shrank, or it was on the other side to begin with.
  const debitsControlAccount = !isNegative(delta);

  const controlLine = {
    accountId: params.accountId,
    partyType: params.partyType ?? null,
    partyId: params.partyId ?? null,
    narration: params.narration,
    ...(debitsControlAccount
      ? { debit: magnitude }
      : { credit: magnitude }),
  };

  const capitalLine = {
    accountId: params.context.capitalAccountId,
    narration: "Owner's capital — opening position",
    ...(debitsControlAccount
      ? { credit: magnitude }
      : { debit: magnitude }),
  };

  const entry = await postJournalEntry(tx, {
    companyId: params.companyId,
    branchId: params.context.branchId,
    entryDate: params.context.date,
    voucherType: VoucherType.OPENING_BALANCE,
    narration: params.narration,
    isSystem: true,
    createdById: params.createdById,
    sourceType: params.source,
    sourceId: params.sourceId,
    lines: [controlLine, capitalLine],
  });

  return { entryNumber: entry.entryNumber, delta: toStorageString(delta) };
}

/**
 * What has already been posted as an opening position for one record.
 *
 * Summing the entries rather than trusting the master row means a correction
 * posted by any route — this module, a manual journal, an import — is accounted
 * for, so a later edit computes its delta against the ledger and not against a
 * number that may have drifted from it.
 */
export async function postedOpeningFor(
  tx: DbClient,
  params: {
    companyId: string;
    accountId: string;
    source: OpeningSource;
    sourceId: string;
  },
): Promise<Decimal> {
  const totals = await tx.journalLine.aggregate({
    where: {
      companyId: params.companyId,
      accountId: params.accountId,
      status: "POSTED",
      journalEntry: {
        companyId: params.companyId,
        sourceType: params.source,
        sourceId: params.sourceId,
      },
    },
    _sum: { debit: true, credit: true },
  });

  return subtract(totals._sum.debit ?? 0, totals._sum.credit ?? 0);
}
