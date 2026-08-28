import "server-only";
import { prisma } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { add, money, subtract, toStorageString } from "@/lib/money";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import {
  accountBalances,
  naturalAmount,
  type AccountBalance,
} from "@/server/accounting/balances";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import { TrialBalanceUnbalancedError } from "@/server/accounting/trial-balance-service";
import { getStockSummary } from "@/server/inventory/inventory-report";
import { netPurchases } from "@/server/purchases/purchase-service";
import {
  payablesAgeing,
  receivablesAgeing,
} from "@/server/settlements/outstanding";

/**
 * The figures on the front page.
 *
 * The dashboard shipped before the modules behind it did, so eight of its
 * twelve tiles were placeholders that named the module they were waiting for:
 * "Arrives with the Sales module", "Arrives with the Inventory module",
 * "Arrives with Purchases and Payments". Every one of those modules has since
 * shipped. The notes stayed. A shop that had been trading for months opened the
 * product to a front page telling it that most of its numbers were not built
 * yet, with the ageing report, the stock valuation and the GST register one
 * click away holding exactly those numbers.
 *
 * **Nothing here computes a figure a second way.** Each one is read from the
 * module that owns it — the balance engine for positions, the statements for
 * trading, the ageing for what is owed, the stock report for what is on the
 * shelves. A dashboard that added up its own version of gross profit would
 * eventually disagree with the profit and loss account, and the one place a
 * disagreement is guaranteed to be noticed is the screen everybody opens first.
 *
 * The pending mechanism stays for anything genuinely absent. What it may not do
 * is name a module that exists.
 */

export type TradingFigures = {
  revenue: string;
  costOfSales: string;
  grossProfit: string;
  /** Null where there was no revenue: a margin on nothing is not a number. */
  grossMarginPercent: number | null;
  purchases: string;
  expenses: string;
  netProfit: string;
};

export type DashboardOverview = {
  /** Positions: what the business holds and is owed, as things stand. */
  cash: string;
  bank: string;
  capital: string;
  receivables: string;
  receivablesOverdue: string;
  payables: string;
  payablesOverdue: string;
  inventoryValue: string;
  /**
   * Output tax less input credit, as the ledger has it.
   *
   * Deliberately not the figure on a GST return. A return is filed for one
   * month and sets off credit against liability with a carry-forward; this is
   * the position the books are in, which is what a dashboard is for. The tile
   * says so, and links to the working paper for the figure that gets filed.
   */
  gstOnTheBooks: string;
  /**
   * Trading for the selected year, or null when it cannot be produced — which
   * happens only when the ledger does not balance, and the trial balance tile
   * beside it already says that.
   */
  trading: TradingFigures | null;
  /** What the trial balance says, which the page reports in its own right. */
  books: {
    postedAccounts: number;
    totalDebit: string;
    totalCredit: string;
    difference: string;
    balanced: boolean;
  };
  /** True when nothing at all has been posted: every figure is honestly zero. */
  empty: boolean;
};

export async function getDashboardOverview(params: {
  companyId: string;
  /** The year in the header. Positions are as at its end; trading is within. */
  from: Date;
  to: Date;
}): Promise<DashboardOverview> {
  const { companyId, from, to } = params;

  const [balances, receivable, payable, stock, purchases, statements] =
    await Promise.all([
      // The one place balances are computed, rather than the dashboard's own
      // groupBy — which is how a front page comes to disagree with a ledger.
      //
      // No `from`: cash in hand is a position, not a movement. Scoped to the
      // selected year it would read the same while a tenant has had only one
      // year, and on the first of April the cash a shop opened with would
      // vanish from its own front page.
      accountBalances({ companyId, to }),
      receivablesAgeing(companyId),
      payablesAgeing(companyId),
      getStockSummary({ companyId }),
      // Read from the module that owns the fact, like every other figure
      // here. This was a private helper that summed posted bills and stopped,
      // which is the one thing this file's own comment says it must not do.
      netPurchases(prisma, { companyId, from, to }),
      financialStatements({ companyId, from, to }),
    ]);

  const positionFor = (systemKey: string): string => {
    const account = balances.find((row) => row.systemKey === systemKey);
    return toStorageString(account ? naturalAmount(account) : 0);
  };

  const sumOf = (systemKeys: readonly string[]): ReturnType<typeof money> =>
    systemKeys.reduce((total, key) => {
      const account = balances.find((row) => row.systemKey === key);
      return account ? add(total, naturalAmount(account)) : total;
    }, money(0));

  const outputTax = sumOf([
    SYSTEM_ACCOUNT.GST_OUTPUT_CGST,
    SYSTEM_ACCOUNT.GST_OUTPUT_SGST,
    SYSTEM_ACCOUNT.GST_OUTPUT_IGST,
    SYSTEM_ACCOUNT.GST_OUTPUT_CESS,
  ]);
  const inputCredit = sumOf([
    SYSTEM_ACCOUNT.GST_INPUT_CGST,
    SYSTEM_ACCOUNT.GST_INPUT_SGST,
    SYSTEM_ACCOUNT.GST_INPUT_IGST,
    SYSTEM_ACCOUNT.GST_INPUT_CESS,
  ]);

  return {
    cash: positionFor(SYSTEM_ACCOUNT.CASH),
    bank: positionFor(SYSTEM_ACCOUNT.BANK),
    capital: positionFor(SYSTEM_ACCOUNT.OWNER_CAPITAL),
    receivables: receivable.summary.total,
    receivablesOverdue: receivable.summary.overdue,
    payables: payable.summary.total,
    payablesOverdue: payable.summary.overdue,
    inventoryValue: stock.totalValue,
    gstOnTheBooks: toStorageString(subtract(outputTax, inputCredit)),
    trading: statements && {
      revenue: statements.trading.revenueTotal,
      costOfSales: statements.trading.costOfSalesTotal,
      grossProfit: statements.trading.grossProfit,
      grossMarginPercent: statements.trading.grossMarginPercent,
      purchases: toStorageString(purchases),
      expenses: statements.profitAndLoss.expensesTotal,
      netProfit: statements.profitAndLoss.netProfit,
    },
    books: booksFrom(balances),
    empty: balances.every((row) => !row.hasMovement),
  };
}

/**
 * The statements, or nothing when the ledger does not balance.
 *
 * They refuse rather than round, which is right — but a dashboard that threw
 * would take the whole front page down over a defect its own trial-balance tile
 * is there to report. So the refusal is caught here and the trading tiles say
 * what the trial balance already says.
 */
async function financialStatements(params: {
  companyId: string;
  from: Date;
  to: Date;
}) {
  try {
    return await getFinancialStatements({
      companyId: params.companyId,
      from: isoDay(params.from),
      to: isoDay(params.to),
    });
  } catch (error) {
    if (error instanceof TrialBalanceUnbalancedError) return null;
    throw error;
  }
}

/**
 * The trial balance, struck over every account rather than the printed ones.
 *
 * The same check the trial balance page runs, from the same closing figures, so
 * the front page cannot call the books balanced while the report calls them
 * broken.
 */
function booksFrom(balances: readonly AccountBalance[]) {
  const posted = balances.filter((row) => row.hasMovement);
  const check = trialBalanceIsBalanced(
    posted.map((row) => ({
      debit: row.closingDebit,
      credit: row.closingCredit,
    })),
  );

  return {
    postedAccounts: posted.length,
    totalDebit: toStorageString(check.totalDebit),
    totalCredit: toStorageString(check.totalCredit),
    difference: toStorageString(check.difference),
    balanced: check.balanced,
  };
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
