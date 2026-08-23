import "server-only";
import type { AccountType } from "@prisma/client";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import { ACCOUNT_TYPE_LABELS } from "@/lib/accounting/account-tree";
import { add, money, subtract, toStorageString } from "@/lib/money";
import { accountBalances, type AccountBalance } from "./balances";

/**
 * The trial balance.
 *
 * Every account with a balance, in two columns, totalled. It is the checkpoint
 * between the ledger and the financial statements: if the two columns do not
 * agree there is no point producing a balance sheet, because it cannot be
 * right.
 *
 * Two things about it are worth being honest about, and the page says both.
 *
 * **A balanced trial balance does not mean the books are correct.** A purchase
 * posted to Rent instead of Purchases balances perfectly and is still wrong. It
 * catches arithmetic, not judgement — and in this system it catches very little
 * even of that, because an unbalanced entry cannot be written in the first
 * place. It is here because it is the report an accountant asks for, and
 * because seeing it agree is worth something.
 *
 * **Balances are reported where they actually sit.** A supplier ledger with a
 * debit balance is an advance paid, and putting it in the credit column because
 * payables are "supposed to" be credits would hide exactly the oddity the
 * report exists to surface.
 */

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  groupCode: string;
  groupName: string;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
  isSystem: boolean;
  isActive: boolean;
};

export type TrialBalanceSection = {
  type: AccountType;
  label: string;
  rows: TrialBalanceRow[];
  subtotalDebit: string;
  subtotalCredit: string;
};

export type TrialBalance = {
  from: string | null;
  to: string;
  sections: TrialBalanceSection[];
  totalDebit: string;
  totalCredit: string;
  difference: string;
  balanced: boolean;
  /** Accounts shown, and how many were left out for having no balance. */
  shown: number;
  omitted: number;
  /** True when a window was given, so opening and movement columns mean something. */
  hasWindow: boolean;
};

/** The order an accountant expects to read them in. */
const TYPE_ORDER: AccountType[] = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "INCOME",
  "EXPENSE",
];

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Whether a row is worth printing.
 *
 * An account that has never been touched is noise on a report a person reads
 * line by line. One that moved during the period and happens to net to nil is
 * not — that is a fact about the period, and hiding it would make the movement
 * columns fail to add up to the total underneath them.
 */
function isInteresting(balance: AccountBalance, hasWindow: boolean): boolean {
  if (!balance.closingDebit.isZero() || !balance.closingCredit.isZero()) {
    return true;
  }
  if (!hasWindow) return false;
  return !balance.periodDebit.isZero() || !balance.periodCredit.isZero();
}

export async function getTrialBalance(params: {
  companyId: string;
  from?: string | null;
  to?: string | null;
  branchId?: string | null;
  /** Include accounts with no balance and no movement. */
  includeEmpty?: boolean;
}): Promise<TrialBalance> {
  const from = params.from ? new Date(`${params.from}T00:00:00.000Z`) : null;
  const to = params.to ? new Date(`${params.to}T00:00:00.000Z`) : new Date();
  const hasWindow = from !== null;

  const balances = await accountBalances({
    companyId: params.companyId,
    from,
    to,
    branchId: params.branchId ?? null,
  });

  const kept = params.includeEmpty
    ? balances
    : balances.filter((balance) => isInteresting(balance, hasWindow));

  const sections: TrialBalanceSection[] = TYPE_ORDER.map((type) => {
    const rows = kept
      .filter((balance) => balance.type === type)
      .map((balance): TrialBalanceRow => ({
        accountId: balance.id,
        code: balance.code,
        name: balance.name,
        type: balance.type,
        groupCode: balance.groupCode,
        groupName: balance.groupName,
        openingDebit: toStorageString(balance.openingDebit),
        openingCredit: toStorageString(balance.openingCredit),
        periodDebit: toStorageString(balance.periodDebit),
        periodCredit: toStorageString(balance.periodCredit),
        closingDebit: toStorageString(balance.closingDebit),
        closingCredit: toStorageString(balance.closingCredit),
        isSystem: balance.isSystem,
        isActive: balance.isActive,
      }));

    return {
      type,
      label: ACCOUNT_TYPE_LABELS[type],
      rows,
      subtotalDebit: toStorageString(
        add(...rows.map((row) => row.closingDebit)),
      ),
      subtotalCredit: toStorageString(
        add(...rows.map((row) => row.closingCredit)),
      ),
    };
  }).filter((section) => section.rows.length > 0);

  // Totalled from every account, not only the printed ones: a row omitted for
  // being nil contributes nothing, so the two are equal — but computing from
  // the full set means a filtering bug can never silently unbalance the report.
  const totals = trialBalanceIsBalanced(
    balances.map((balance) => ({
      debit: balance.closingDebit,
      credit: balance.closingCredit,
    })),
  );

  return {
    from: from ? isoDay(from) : null,
    to: isoDay(to),
    sections,
    totalDebit: toStorageString(totals.totalDebit),
    totalCredit: toStorageString(totals.totalCredit),
    difference: toStorageString(totals.difference),
    balanced: totals.balanced,
    shown: kept.length,
    omitted: balances.length - kept.length,
    hasWindow,
  };
}

/**
 * The gate the financial statements sit behind.
 *
 * Phase 14 produces a trading account, a profit and loss account and a balance
 * sheet from these same balances. Producing any of them from a ledger that does
 * not balance would mean publishing a figure known to be wrong, so the check
 * happens once, here, and the statements refuse rather than round.
 */
export class TrialBalanceUnbalancedError extends Error {
  constructor(readonly difference: string) {
    super(
      `The ledger does not balance: debits and credits differ by ${difference}. No statement can be produced from it until that is investigated.`,
    );
    this.name = "TrialBalanceUnbalancedError";
  }
}

export async function assertLedgerBalances(params: {
  companyId: string;
  to?: string | null;
  branchId?: string | null;
}): Promise<void> {
  const balances = await accountBalances({
    companyId: params.companyId,
    to: params.to ? new Date(`${params.to}T00:00:00.000Z`) : null,
    branchId: params.branchId ?? null,
  });

  const totals = trialBalanceIsBalanced(
    balances.map((balance) => ({
      debit: balance.closingDebit,
      credit: balance.closingCredit,
    })),
  );

  if (!totals.balanced) {
    throw new TrialBalanceUnbalancedError(toStorageString(totals.difference));
  }
}

/**
 * Rows flattened for a CSV, in the order they are printed.
 *
 * Kept beside the report rather than in the route so the file and the screen
 * can never drift apart — an export that disagrees with what was on screen is
 * worse than no export.
 */
export function toCsvRows(trial: TrialBalance): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];

  for (const section of trial.sections) {
    for (const row of section.rows) {
      rows.push({
        Type: section.label,
        Group: row.groupName,
        Code: row.code,
        Account: row.name,
        ...(trial.hasWindow
          ? {
              "Opening Dr": row.openingDebit,
              "Opening Cr": row.openingCredit,
              "Period Dr": row.periodDebit,
              "Period Cr": row.periodCredit,
            }
          : {}),
        "Closing Dr": row.closingDebit,
        "Closing Cr": row.closingCredit,
      });
    }
  }

  return rows;
}

/** Difference between two figures, for the page to describe an imbalance. */
export function differenceBetween(
  debit: string,
  credit: string,
): { amount: string; side: "debit" | "credit" | "none" } {
  const gap = subtract(money(debit), money(credit));
  if (gap.isZero()) return { amount: toStorageString(0), side: "none" };
  return {
    amount: toStorageString(gap.abs()),
    side: gap.isNegative() ? "credit" : "debit",
  };
}
