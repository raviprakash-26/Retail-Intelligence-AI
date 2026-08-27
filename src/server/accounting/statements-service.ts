import "server-only";
import type { AccountType, StatementSection } from "@prisma/client";
import {
  add,
  money,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";
import {
  accountBalances,
  naturalAmount,
  type AccountBalance,
} from "./balances";
import { TrialBalanceUnbalancedError } from "./trial-balance-service";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";

/**
 * The financial statements.
 *
 * A trading account, a profit and loss account and a balance sheet, all three
 * derived from the same posted lines the ledger and the trial balance read. No
 * figure here is stored, and none is computed a second way.
 *
 * **They are gated on the ledger balancing.** Producing a balance sheet from a
 * ledger whose two sides disagree means publishing a figure known to be wrong,
 * so the check happens first and the statements refuse rather than round.
 *
 * **The trading account is the perpetual form, because this system keeps
 * perpetual inventory.** A bill debits stock, not a Purchases account, and a
 * sale moves cost out of stock into cost of sales at the moment it happens. The
 * textbook periodic layout — opening stock plus purchases less closing stock —
 * would print ₹0 against Purchases here and be nonsense. Gross profit is
 * revenue less the cost of what was actually sold, and the page says so, so
 * nobody goes looking for a Purchases line that will never have anything in it.
 *
 * **Profit for the period appears in capital on the balance sheet.** Income and
 * expense accounts are not closed to retained earnings until a year-end close,
 * which this system does not yet perform, so the balance sheet adds the period's
 * profit into the owner's stake itself. Without it the two halves would differ
 * by exactly the profit — and it is the owner's, whether or not a closing entry
 * has been written.
 */

export type StatementLine = {
  accountId: string;
  code: string;
  name: string;
  /** Positive in the direction the line belongs; negative for a contra. */
  amount: string;
};

export type StatementGroup = {
  code: string;
  name: string;
  lines: StatementLine[];
  total: string;
};

export type TradingAccount = {
  revenue: StatementGroup[];
  revenueTotal: string;
  costOfSales: StatementGroup[];
  costOfSalesTotal: string;
  grossProfit: string;
  /** Null when there was no revenue — a margin on nothing is not a number. */
  grossMarginPercent: number | null;
};

export type ProfitAndLoss = {
  grossProfit: string;
  otherIncome: StatementGroup[];
  otherIncomeTotal: string;
  expenses: StatementGroup[];
  expensesTotal: string;
  netProfit: string;
  netMarginPercent: number | null;
};

export type BalanceSheet = {
  assets: StatementGroup[];
  assetsTotal: string;
  liabilities: StatementGroup[];
  liabilitiesTotal: string;
  equity: StatementGroup[];
  /**
   * Everything earned up to the closing date and not yet closed to capital.
   * Equals the period's profit only when the period covers the whole history;
   * on a sub-window it also carries what earlier periods earned.
   */
  earningsToDate: string;
  equityTotal: string;
  /** Liabilities plus capital: the figure assets must equal. */
  fundingTotal: string;
  difference: string;
  balanced: boolean;
};

export type FinancialStatements = {
  from: string;
  to: string;
  trading: TradingAccount;
  profitAndLoss: ProfitAndLoss;
  balanceSheet: BalanceSheet;
  /** True when nothing at all has been posted in or before the period. */
  empty: boolean;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Groups balances by their account group, dropping anything that nets to nil.
 *
 * A statement is read line by line by a person, so an account sitting at zero
 * is noise. A group left with no lines disappears with them.
 */
function groupLines(balances: readonly AccountBalance[]): StatementGroup[] {
  const groups = new Map<string, StatementGroup>();

  for (const balance of balances) {
    const amount = naturalAmount(balance);
    if (amount.isZero()) continue;

    const existing = groups.get(balance.groupCode);
    const line: StatementLine = {
      accountId: balance.id,
      code: balance.code,
      name: balance.name,
      amount: toStorageString(amount),
    };

    if (existing) existing.lines.push(line);
    else {
      groups.set(balance.groupCode, {
        code: balance.groupCode,
        name: balance.groupName,
        lines: [line],
        total: "0",
      });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      lines: group.lines.sort((a, b) =>
        a.code.localeCompare(b.code, undefined, { numeric: true }),
      ),
      total: toStorageString(add(...group.lines.map((line) => line.amount))),
    }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

const totalOf = (groups: readonly StatementGroup[]): Decimal =>
  add(...groups.map((group) => group.total));

/** Percentage of revenue, to one decimal. Null when there is no revenue. */
function marginPercent(part: Decimal, revenue: Decimal): number | null {
  if (revenue.isZero()) return null;
  return Number(part.dividedBy(revenue).times(100).toFixed(1));
}

/**
 * Balances restricted to a period, in the direction each class belongs.
 *
 * Income and expenses are measured *over* the period; assets, liabilities and
 * capital are measured *at* its end. Mixing the two is the classic way to
 * produce a balance sheet that does not balance, so the two windows are read
 * separately and each statement is given the one it needs.
 */
async function loadBalances(params: {
  companyId: string;
  from: Date;
  to: Date;
  branchId?: string | null;
}) {
  const [period, cumulative] = await Promise.all([
    accountBalances({
      companyId: params.companyId,
      from: params.from,
      to: params.to,
      branchId: params.branchId ?? null,
      // The year's own closing entry is not trading, and read as movement it
      // erases the year it settles: revenue credited across twelve months and
      // debited once on the last day nets to nil. So closing a year emptied
      // its own profit and loss account — and with it the book profit the
      // income tax working paper is built on, which read nil turnover and nil
      // taxable income for a year the shop had traded through. Closing happens
      // at the year end and the return is filed after it, so the figure was
      // destroyed exactly when it came to be needed.
      excludeClosingEntries: true,
    }),
    // Positions keep it. The balance sheet is drawn from these and depends on
    // the transfer having happened: with the income accounts zeroed,
    // `earnedToDate` falls to nil of its own accord and retained earnings
    // carries the amount instead. Excluding it here would count the year's
    // profit twice.
    accountBalances({
      companyId: params.companyId,
      to: params.to,
      branchId: params.branchId ?? null,
    }),
  ]);

  // Income and expense figures are the period's movement, so the closing
  // columns of the period-scoped read are exactly what the statements want.
  const inPeriod = (section: StatementSection, type?: AccountType) =>
    period
      .filter((balance) => balance.section === section)
      .filter((balance) => !type || balance.type === type)
      .map((balance) => ({
        ...balance,
        closingDebit: balance.periodDebit,
        closingCredit: balance.periodCredit,
      }));

  return { period, cumulative, inPeriod };
}

export async function getFinancialStatements(params: {
  companyId: string;
  from: string;
  to: string;
  branchId?: string | null;
}): Promise<FinancialStatements> {
  const from = new Date(`${params.from}T00:00:00.000Z`);
  const to = new Date(`${params.to}T00:00:00.000Z`);

  const { cumulative, inPeriod } = await loadBalances({
    companyId: params.companyId,
    from,
    to,
    branchId: params.branchId,
  });

  // The gate. Checked against the position at the end of the period, which is
  // what the balance sheet will be drawn from.
  const check = trialBalanceIsBalanced(
    cumulative.map((balance) => ({
      debit: balance.closingDebit,
      credit: balance.closingCredit,
    })),
  );
  if (!check.balanced) {
    throw new TrialBalanceUnbalancedError(toStorageString(check.difference));
  }

  // --- Trading account ----------------------------------------------------
  const tradingRows = inPeriod("TRADING");
  const revenue = groupLines(
    tradingRows.filter((balance) => balance.type === "INCOME"),
  );
  const costOfSales = groupLines(
    tradingRows.filter((balance) => balance.type === "EXPENSE"),
  );
  const revenueTotal = totalOf(revenue);
  const costOfSalesTotal = totalOf(costOfSales);
  const grossProfit = subtract(revenueTotal, costOfSalesTotal);

  const trading: TradingAccount = {
    revenue,
    revenueTotal: toStorageString(revenueTotal),
    costOfSales,
    costOfSalesTotal: toStorageString(costOfSalesTotal),
    grossProfit: toStorageString(grossProfit),
    grossMarginPercent: marginPercent(grossProfit, revenueTotal),
  };

  // --- Profit and loss ----------------------------------------------------
  const plRows = inPeriod("PROFIT_AND_LOSS");
  const otherIncome = groupLines(
    plRows.filter((balance) => balance.type === "INCOME"),
  );
  const expenses = groupLines(
    plRows.filter((balance) => balance.type === "EXPENSE"),
  );
  const otherIncomeTotal = totalOf(otherIncome);
  const expensesTotal = totalOf(expenses);
  const netProfit = subtract(add(grossProfit, otherIncomeTotal), expensesTotal);

  const profitAndLoss: ProfitAndLoss = {
    grossProfit: toStorageString(grossProfit),
    otherIncome,
    otherIncomeTotal: toStorageString(otherIncomeTotal),
    expenses,
    expensesTotal: toStorageString(expensesTotal),
    netProfit: toStorageString(netProfit),
    netMarginPercent: marginPercent(netProfit, revenueTotal),
  };

  // --- Balance sheet ------------------------------------------------------
  // Positions, not movement: read from the cumulative balances at `to`.
  const sheetRows = cumulative.filter(
    (balance) => balance.section === "BALANCE_SHEET",
  );
  const assets = groupLines(
    sheetRows.filter((balance) => balance.type === "ASSET"),
  );
  const liabilities = groupLines(
    sheetRows.filter((balance) => balance.type === "LIABILITY"),
  );
  const equity = groupLines(
    sheetRows.filter((balance) => balance.type === "EQUITY"),
  );

  const assetsTotal = totalOf(assets);
  const liabilitiesTotal = totalOf(liabilities);

  // Profit earned before this period opened is already sitting in the income
  // and expense accounts too — nothing has closed them — so the figure the
  // balance sheet needs is everything earned up to `to`, not just the period's.
  const earnedToDate = subtract(
    add(
      ...cumulative
        .filter((balance) => balance.type === "INCOME")
        .map((balance) => naturalAmount(balance)),
    ),
    add(
      ...cumulative
        .filter((balance) => balance.type === "EXPENSE")
        .map((balance) => naturalAmount(balance)),
    ),
  );

  const equityTotal = add(totalOf(equity), earnedToDate);
  const fundingTotal = add(liabilitiesTotal, equityTotal);
  const difference = subtract(assetsTotal, fundingTotal);

  const balanceSheet: BalanceSheet = {
    assets,
    assetsTotal: toStorageString(assetsTotal),
    liabilities,
    liabilitiesTotal: toStorageString(liabilitiesTotal),
    equity,
    earningsToDate: toStorageString(earnedToDate),
    equityTotal: toStorageString(equityTotal),
    fundingTotal: toStorageString(fundingTotal),
    difference: toStorageString(difference),
    balanced: difference.isZero(),
  };

  return {
    from: isoDay(from),
    to: isoDay(to),
    trading,
    profitAndLoss,
    balanceSheet,
    empty:
      revenue.length === 0 &&
      costOfSales.length === 0 &&
      expenses.length === 0 &&
      assets.length === 0 &&
      liabilities.length === 0 &&
      equity.length === 0,
  };
}

/**
 * A plain-language reading of the period.
 *
 * The statements are correct but they are not self-explanatory, and a retailer
 * who cannot read one is exactly who this product is for. Every figure quoted
 * here comes from the statement above it — nothing is estimated, and nothing is
 * described as advice.
 */
export function summarise(statements: FinancialStatements): string[] {
  const notes: string[] = [];
  const revenue = money(statements.trading.revenueTotal);
  const gross = money(statements.trading.grossProfit);
  const net = money(statements.profitAndLoss.netProfit);
  const expenses = money(statements.profitAndLoss.expensesTotal);

  if (revenue.isZero()) {
    notes.push(
      "Nothing was sold in this period, so there is no margin to read.",
    );
    return notes;
  }

  const grossPercent = statements.trading.grossMarginPercent;
  if (grossPercent !== null) {
    notes.push(
      `For every ₹100 of sales, ₹${grossPercent.toFixed(0)} was left after paying for the goods themselves.`,
    );
  }

  if (!expenses.isZero()) {
    const share = Number(expenses.dividedBy(revenue).times(100).toFixed(0));
    notes.push(
      `Running the shop cost ${share}% of sales — rent, salaries, power and the rest.`,
    );
  }

  if (net.isNegative()) {
    notes.push(
      `The period ended at a loss of ${net.abs().toFixed(2)}. Gross profit of ${gross.toFixed(2)} did not cover the cost of running the shop.`,
    );
  } else if (net.isZero()) {
    notes.push("The period broke even exactly.");
  } else {
    notes.push(
      `The period ended with a profit of ${net.toFixed(2)}, which belongs to you and is shown inside your capital on the balance sheet.`,
    );
  }

  return notes;
}
