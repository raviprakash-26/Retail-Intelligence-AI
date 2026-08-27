import "server-only";
import {
  AccountNature,
  type AccountType,
  JournalStatus,
  VoucherType,
  type Prisma,
  type AccountSubType,
  type StatementSection,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { balanceSide, signedBalance } from "@/lib/accounting/double-entry";
import {
  add,
  money,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";

/**
 * What every account is worth, at a date.
 *
 * This is the one place account balances are computed. The ledger, the trial
 * balance, the profit and loss account, the balance sheet and every ratio built
 * on them all read from here, so there is exactly one answer to "what is in
 * Cash in Hand" and no report can disagree with another.
 *
 * Three rules hold it together.
 *
 * **Only posted lines count.** A draft is not a transaction and a voided entry
 * is cancelled by its reversal, which is itself posted — so the two net to zero
 * without anything being excluded by status. Filtering on `POSTED` and letting
 * the reversal do the cancelling is what keeps a voided sale visible in the
 * journal while being absent from the profit figure.
 *
 * **Opening balances are ordinary entries.** A business migrating in posts its
 * starting positions as balanced journal entries on the day before the year
 * opens, so nothing here needs a special case for them. An "opening balance"
 * column that came from a different mechanism than the rest of the ledger is a
 * column that eventually disagrees with it.
 *
 * **Balances are reported where they actually sit, not where they should.** A
 * supplier ledger with a debit balance is an advance paid, and forcing it to
 * the credit column by the account's declared nature would hide exactly the
 * anomaly a trial balance exists to surface.
 */

export type AccountMeta = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subType: AccountSubType;
  nature: AccountNature;
  section: StatementSection;
  groupId: string;
  groupCode: string;
  groupName: string;
  isSystem: boolean;
  isActive: boolean;
  systemKey: string | null;
};

export type AccountBalance = AccountMeta & {
  /** Where the account stood the instant before the window opened. */
  openingDebit: Decimal;
  openingCredit: Decimal;
  /** Movement inside the window. */
  periodDebit: Decimal;
  periodCredit: Decimal;
  /** Where it stands at the close of the window. */
  closingDebit: Decimal;
  closingCredit: Decimal;
  /** Signed, in the direction of the account's own nature. */
  balance: Decimal;
  /** Whether anything at all touched it in the window. */
  hasMovement: boolean;
};

export type BalanceWindow = {
  companyId: string;
  /** Inclusive. Omit for "since the books began". */
  from?: Date | null;
  /** Inclusive. Omit for "up to now". */
  to?: Date | null;
  /** Restrict to one branch. Omit for the whole business. */
  branchId?: string | null;
  /**
   * Leave year-end closing entries out of the movement.
   *
   * A closing entry transfers the year's income and expenses into retained
   * earnings, which means it moves those accounts by the whole of their
   * balances. Read as period movement it cancels the year exactly: revenue
   * credited through the year and debited once at the end nets to nil, so the
   * moment a year is closed its own profit and loss account reads empty.
   *
   * Positions want it and movement does not. The balance sheet is drawn from
   * cumulative balances and *relies* on the transfer having happened — that is
   * what stops the profit being counted once in the income accounts and again
   * in retained earnings. So this is an option rather than a rule, and the
   * statements engine sets it for the trading and profit-and-loss reads only.
   */
  excludeClosingEntries?: boolean;
};

type Totals = { debit: Decimal; credit: Decimal };

const ZERO: Totals = { debit: money(0), credit: money(0) };

/**
 * Sums debits and credits per account over a date range.
 *
 * Grouped in the database rather than in JavaScript: a year of a busy shop is
 * hundreds of thousands of lines, and pulling them across to add them up is the
 * kind of thing that works in a demo and falls over in March.
 */
async function movements(params: {
  companyId: string;
  from?: Date | null;
  to?: Date | null;
  branchId?: string | null;
  accountIds?: readonly string[];
  excludeClosingEntries?: boolean;
}): Promise<Map<string, Totals>> {
  const where: Prisma.JournalLineWhereInput = {
    companyId: params.companyId,
    status: JournalStatus.POSTED,
    ...(params.accountIds ? { accountId: { in: [...params.accountIds] } } : {}),
    ...(params.from || params.to
      ? {
          entryDate: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
    // A branch filter has to reach through to the entry: lines carry the date
    // but not the location. The relation is `journalEntry` — it was written as
    // `entry` here, which Prisma rejects at runtime, so every branch-scoped
    // read threw instead of returning figures.
    //
    // Nothing caught it, and the reason is worth keeping: a key inside a
    // conditional spread is not excess-property checked, so a wrong name in
    // this position type-checks exactly like a right one. Only running the
    // query tells the two apart, and no caller passed a branch, so nothing
    // ever did. The trial balance and statements suites now do.
    ...(params.branchId ? { journalEntry: { branchId: params.branchId } } : {}),
    ...(params.excludeClosingEntries
      ? {
          journalEntry: {
            ...(params.branchId ? { branchId: params.branchId } : {}),
            voucherType: { not: VoucherType.CLOSING_ENTRY },
          },
        }
      : {}),
  };

  const rows = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where,
    _sum: { debit: true, credit: true },
  });

  return new Map(
    rows.map((row) => [
      row.accountId,
      {
        debit: money(row._sum.debit ?? 0),
        credit: money(row._sum.credit ?? 0),
      },
    ]),
  );
}

/** Every account in the chart, with its group, ordered by code. */
export async function listAccountMeta(
  companyId: string,
  options: { includeInactive?: boolean } = {},
): Promise<AccountMeta[]> {
  const accounts = await prisma.account.findMany({
    where: {
      companyId,
      ...(options.includeInactive ? {} : { isActive: true }),
    },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      subType: true,
      nature: true,
      section: true,
      groupId: true,
      isSystem: true,
      isActive: true,
      systemKey: true,
      group: { select: { code: true, name: true } },
    },
    orderBy: { code: "asc" },
  });

  return accounts.map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    subType: account.subType,
    nature: account.nature,
    section: account.section,
    groupId: account.groupId,
    groupCode: account.group.code,
    groupName: account.group.name,
    isSystem: account.isSystem,
    isActive: account.isActive,
    systemKey: account.systemKey,
  }));
}

/**
 * Balances for every account, split into what was carried in and what moved.
 *
 * The opening figure is a second aggregate over everything before the window
 * rather than a stored running total. Stored balances drift the moment an entry
 * is backdated or voided, and there is nothing to reconcile them against; this
 * is always derivable from the lines themselves.
 */
export async function accountBalances(
  window: BalanceWindow,
): Promise<AccountBalance[]> {
  // Every account, retired ones included, and not optionally.
  //
  // This took an `includeInactive` flag defaulting to false, so a caller that
  // did not think about it got the active chart. Every financial reader here
  // wants the whole of it: an account holds a balance and a history whether or
  // not somebody has since put it away, and retiring one is allowed *because*
  // its balance is nil today, which says nothing about what went through it
  // last year.
  //
  // Six callers passed `true` and the flag was silent noise; two did not and
  // were wrong for it. The year's close left a retired account's balance out of
  // the result it transferred, and the income-tax cash mix lost a closed bank
  // account's receipts out of the figure that decides a presumptive ceiling.
  // A default that is right six times in eight is a trap rather than a default,
  // so there is no longer one to get wrong.
  //
  // `listAccountMeta` keeps its own flag: a picker offering accounts to post to
  // genuinely does want the active ones, which is a different question from
  // what an account is worth.
  const meta = await listAccountMeta(window.companyId, {
    includeInactive: true,
  });

  const [opening, period] = await Promise.all([
    // Only worth asking when the window has a start; without one, everything
    // is period movement and the opening column is structurally zero.
    window.from
      ? movements({
          companyId: window.companyId,
          to: new Date(window.from.getTime() - 1),
          branchId: window.branchId,
        })
      : Promise.resolve(new Map<string, Totals>()),
    movements({
      companyId: window.companyId,
      from: window.from,
      to: window.to,
      branchId: window.branchId,
      excludeClosingEntries: window.excludeClosingEntries,
    }),
  ]);

  return meta.map((account) => {
    const before = opening.get(account.id) ?? ZERO;
    const during = period.get(account.id) ?? ZERO;

    const openingSide = balanceSide(before.debit, before.credit);
    const closing = balanceSide(
      add(before.debit, during.debit),
      add(before.credit, during.credit),
    );

    return {
      ...account,
      openingDebit: openingSide.debit,
      openingCredit: openingSide.credit,
      periodDebit: during.debit,
      periodCredit: during.credit,
      closingDebit: closing.debit,
      closingCredit: closing.credit,
      balance: signedBalance(
        account.nature,
        add(before.debit, during.debit),
        add(before.credit, during.credit),
      ),
      hasMovement:
        !during.debit.isZero() ||
        !during.credit.isZero() ||
        !openingSide.debit.isZero() ||
        !openingSide.credit.isZero(),
    };
  });
}

/** One account's balance. Used by the ledger and by account deletion checks. */
export async function accountBalance(
  window: BalanceWindow & { accountId: string },
): Promise<Totals & { balance: Decimal; nature: AccountNature }> {
  const account = await prisma.account.findFirst({
    where: { id: window.accountId, companyId: window.companyId },
    select: { nature: true },
  });
  if (!account) {
    return { ...ZERO, balance: money(0), nature: AccountNature.DEBIT };
  }

  const totals =
    (
      await movements({
        companyId: window.companyId,
        from: window.from,
        to: window.to,
        branchId: window.branchId,
        accountIds: [window.accountId],
      })
    ).get(window.accountId) ?? ZERO;

  return {
    ...totals,
    balance: signedBalance(account.nature, totals.debit, totals.credit),
    nature: account.nature,
  };
}

/** How many posted lines an account carries. Zero means it is safe to retire. */
export async function accountLineCount(params: {
  companyId: string;
  accountId: string;
}): Promise<number> {
  return prisma.journalLine.count({
    where: {
      companyId: params.companyId,
      accountId: params.accountId,
      status: { in: [JournalStatus.POSTED, JournalStatus.DRAFT] },
    },
  });
}

// ---------------------------------------------------------------------------
// Aggregates the statements are built from
// ---------------------------------------------------------------------------

export type SectionTotals = {
  /** Positive means the section is on its natural side. */
  trading: Decimal;
  profitAndLoss: Decimal;
  balanceSheet: Decimal;
};

/** Which side a whole class of accounts sits on, regardless of any one of them. */
export const NATURAL_SIDE_FOR_TYPE: Record<AccountType, AccountNature> = {
  ASSET: AccountNature.DEBIT,
  LIABILITY: AccountNature.CREDIT,
  EQUITY: AccountNature.CREDIT,
  INCOME: AccountNature.CREDIT,
  EXPENSE: AccountNature.DEBIT,
};

/**
 * One account's contribution to its class, in that class's direction.
 *
 * The single place any report converts a pair of debit and credit columns into
 * a figure it can add up. A contra account — accumulated depreciation, drawings,
 * sales returns, purchase returns — comes back negative, which is exactly right:
 * each reduces the class it belongs to. Every statement reads this rather than
 * deciding for itself which way up an account goes.
 */
export function naturalAmount(balance: {
  type: AccountType;
  closingDebit: Decimal;
  closingCredit: Decimal;
}): Decimal {
  return signedBalance(
    NATURAL_SIDE_FOR_TYPE[balance.type],
    balance.closingDebit,
    balance.closingCredit,
  );
}

/**
 * Totals a set of balances by account type.
 *
 * Summed in the direction of the *type*, not of each individual account, and
 * that distinction is the whole point. Several accounts deliberately run
 * against their class: accumulated depreciation is an asset carrying a credit
 * balance, drawings sit inside capital carrying a debit one, sales returns run
 * against income and purchase returns against purchases. Each is a contra
 * account, and each *reduces* the class it belongs to.
 *
 * Adding them in their own direction would report accumulated depreciation as
 * an asset the business owns and drawings as capital the owner had put in —
 * both backwards, and both enough to make the accounting equation fail on any
 * sole proprietorship that has ever taken money out.
 *
 * `balance` on each row stays signed by the account's own nature, because that
 * is what a person reading the chart wants to see; this reads the debit and
 * credit columns instead.
 */
export function totalByType(
  balances: readonly AccountBalance[],
): Record<AccountType, Decimal> {
  const totals: Record<AccountType, Decimal> = {
    ASSET: money(0),
    LIABILITY: money(0),
    EQUITY: money(0),
    INCOME: money(0),
    EXPENSE: money(0),
  };

  for (const balance of balances) {
    totals[balance.type] = add(totals[balance.type], naturalAmount(balance));
  }
  return totals;
}

/**
 * The accounting equation, checked against real balances.
 *
 * Assets = Liabilities + Equity + (Income − Expenses). If this is ever untrue
 * the ledger is broken, not the report — which is why it is worth computing and
 * showing rather than assuming.
 */
export function accountingEquation(balances: readonly AccountBalance[]): {
  assets: Decimal;
  liabilities: Decimal;
  equity: Decimal;
  income: Decimal;
  expenses: Decimal;
  /** Income − expenses; what equity gains before anything is drawn out. */
  profit: Decimal;
  difference: Decimal;
  balanced: boolean;
} {
  const totals = totalByType(balances);
  const profit = subtract(totals.INCOME, totals.EXPENSE);
  const difference = subtract(
    totals.ASSET,
    add(totals.LIABILITY, totals.EQUITY, profit),
  );

  return {
    assets: totals.ASSET,
    liabilities: totals.LIABILITY,
    equity: totals.EQUITY,
    income: totals.INCOME,
    expenses: totals.EXPENSE,
    profit,
    difference,
    balanced: difference.isZero(),
  };
}

/** Serialised for a client component, which cannot receive a Decimal. */
export type SerialisedBalance = Omit<
  AccountBalance,
  | "openingDebit"
  | "openingCredit"
  | "periodDebit"
  | "periodCredit"
  | "closingDebit"
  | "closingCredit"
  | "balance"
> & {
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
  balance: string;
};

export function serialiseBalance(balance: AccountBalance): SerialisedBalance {
  return {
    ...balance,
    openingDebit: toStorageString(balance.openingDebit),
    openingCredit: toStorageString(balance.openingCredit),
    periodDebit: toStorageString(balance.periodDebit),
    periodCredit: toStorageString(balance.periodCredit),
    closingDebit: toStorageString(balance.closingDebit),
    closingCredit: toStorageString(balance.closingCredit),
    balance: toStorageString(balance.balance),
  };
}
