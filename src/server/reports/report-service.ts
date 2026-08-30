import "server-only";
import { formatDate } from "@/lib/format";
import {
  findReport,
  type ReportEntityKind,
  type ReportKey,
} from "@/lib/reports/catalogue";
import {
  row,
  type ReportColumn,
  type ReportResult,
} from "@/lib/reports/result";
import { add, money, toStorageString } from "@/lib/money";
import { prisma } from "@/lib/db";
import { asBusinessTimezone } from "@/lib/validation/company";
import { businessToday } from "@/lib/validation/date";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import {
  describeSource,
  listJournalEntries,
} from "@/server/accounting/journal-service";
import { listExpenses } from "@/server/expenses/expense-service";
import { getGstWorkingPaper } from "@/server/gst/gst-return-service";
import { stockRows } from "@/server/inventory/inventory-report";
import { listPurchases } from "@/server/purchases/purchase-service";
import { listSales } from "@/server/sales/sale-service";
import {
  getAccountLedger,
  ledgerAccounts,
  ledgerParties,
  partyStatement,
  type AccountLedger,
} from "@/server/accounting/ledger-service";
import {
  payablesAgeing,
  receivablesAgeing,
} from "@/server/settlements/outstanding";
import type { LedgerAgeing } from "@/server/settlements/outstanding";

/**
 * Running a report.
 *
 * Every function below is an adapter and nothing more: it calls the service
 * that owns the figures, and turns what comes back into rows. There is no
 * arithmetic here beyond adding a register's own column to print a total, and
 * where even that would be a second opinion — profit, tax, stock value — the
 * figure is taken from the source rather than recomputed.
 *
 * That is a deliberate constraint rather than laziness. A reports module that
 * computes is a reports module that will eventually disagree with the page it
 * claims to summarise, and when the trial balance says one thing and the trial
 * balance *report* says another, neither is usable.
 */

export type ReportParams = {
  from?: string;
  to?: string;
  year?: number;
  month?: number;
  /** The account or party a single-subject report is about. */
  entityId?: string;
};

export class ReportError extends Error {
  constructor(
    message: string,
    readonly code: "UNKNOWN_REPORT" | "BAD_PERIOD" | "MISSING_ENTITY",
  ) {
    super(message);
    this.name = "ReportError";
  }
}

/**
 * How many document rows a register will print.
 *
 * A register is read line by line, and a browser asked to lay out a hundred
 * thousand rows stops being a report and becomes a hang. The cap is stated on
 * the report when it bites rather than silently truncating, because a register
 * that quietly stops halfway is worse than one that refuses.
 */
const MAX_DOCUMENT_ROWS = 5_000;

const dayLabel = (iso: string) => formatDate(iso, { style: "short" });

function rangeLabel(from: string, to: string): string {
  return `${dayLabel(from)} to ${dayLabel(to)}`;
}

const MONEY = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: "money",
});
const TEXT = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: "text",
});
const NUMBER = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: "number",
});
const DATE = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: "date",
});

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

async function trialBalanceReport(
  companyId: string,
  from: string,
  to: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  const trial = await getTrialBalance({ companyId, from, to });

  const rows = trial.sections.flatMap((section) => [
    row({ account: section.label }, "group"),
    ...section.rows.map((entry) =>
      row({
        account: `${entry.code} · ${entry.name}`,
        debit: entry.closingDebit,
        credit: entry.closingCredit,
      }),
    ),
    row(
      {
        account: `${section.label} total`,
        debit: section.subtotalDebit,
        credit: section.subtotalCredit,
      },
      "total",
    ),
  ]);

  rows.push(
    row(
      { account: "Total", debit: trial.totalDebit, credit: trial.totalCredit },
      "total",
    ),
  );

  return {
    period: rangeLabel(from, to),
    columns: [
      TEXT("account", "Account"),
      MONEY("debit", "Debit"),
      MONEY("credit", "Credit"),
    ],
    rows,
    notes: [
      trial.balanced
        ? "Debits equal credits."
        : `Out of balance by ${trial.difference}. The ledger, not this report, is where that is fixed.`,
      `${trial.shown} accounts shown; ${trial.omitted} with no balance and no movement were left out.`,
    ],
    empty: trial.shown === 0,
  };
}

function statementGroupRows(
  groups: ReadonlyArray<{
    name: string;
    total: string;
    lines: ReadonlyArray<{ code: string; name: string; amount: string }>;
  }>,
) {
  return groups.flatMap((group) => [
    row({ line: group.name }, "group"),
    ...group.lines.map((entry) =>
      row({ line: `${entry.code} · ${entry.name}`, amount: entry.amount }),
    ),
    row({ line: `${group.name} total`, amount: group.total }, "total"),
  ]);
}

async function profitAndLossReport(
  companyId: string,
  from: string,
  to: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  const statements = await getFinancialStatements({ companyId, from, to });
  const { trading, profitAndLoss } = statements;

  const rows = [
    row({ line: "Trading account" }, "group"),
    ...statementGroupRows(trading.revenue),
    row({ line: "Revenue", amount: trading.revenueTotal }, "total"),
    ...statementGroupRows(trading.costOfSales),
    row({ line: "Cost of sales", amount: trading.costOfSalesTotal }, "total"),
    row({ line: "Gross profit", amount: trading.grossProfit }, "total"),

    row({ line: "Profit and loss" }, "group"),
    ...statementGroupRows(profitAndLoss.otherIncome),
    ...statementGroupRows(profitAndLoss.expenses),
    row({ line: "Expenses", amount: profitAndLoss.expensesTotal }, "total"),
    row({ line: "Net profit", amount: profitAndLoss.netProfit }, "total"),
  ];

  const notes: string[] = [];
  if (trading.grossMarginPercent !== null) {
    notes.push(`Gross margin ${trading.grossMarginPercent.toFixed(1)}%.`);
  }
  if (profitAndLoss.netMarginPercent !== null) {
    notes.push(`Net margin ${profitAndLoss.netMarginPercent.toFixed(1)}%.`);
  }
  notes.push(
    "Built from the ledger, not by adding invoices to expenses. Every figure here is the balance of an account.",
  );

  return {
    period: rangeLabel(from, to),
    columns: [TEXT("line", "Line"), MONEY("amount", "Amount")],
    rows,
    notes,
    empty: statements.empty,
  };
}

async function balanceSheetReport(
  companyId: string,
  to: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  // A balance sheet is a position, not a window; the statements service still
  // wants a start, so it is given the earliest date it will accept and the
  // cumulative column is what gets read.
  const statements = await getFinancialStatements({
    companyId,
    from: "1970-01-01",
    to,
  });
  const sheet = statements.balanceSheet;

  const rows = [
    row({ line: "Assets" }, "group"),
    ...statementGroupRows(sheet.assets),
    row({ line: "Total assets", amount: sheet.assetsTotal }, "total"),

    row({ line: "Liabilities" }, "group"),
    ...statementGroupRows(sheet.liabilities),
    row({ line: "Total liabilities", amount: sheet.liabilitiesTotal }, "total"),

    row({ line: "Equity" }, "group"),
    ...statementGroupRows(sheet.equity),
    row({ line: "Earnings to date", amount: sheet.earningsToDate }),
    row({ line: "Total equity", amount: sheet.equityTotal }, "total"),

    row(
      { line: "Liabilities and equity", amount: sheet.fundingTotal },
      "total",
    ),
  ];

  return {
    period: `as at ${dayLabel(to)}`,
    columns: [TEXT("line", "Line"), MONEY("amount", "Amount")],
    rows,
    notes: [
      sheet.balanced
        ? "Assets equal liabilities plus equity."
        : `Assets and funding differ by ${sheet.difference}.`,
      "Earnings to date are everything earned up to this date and not yet closed to capital — the owner's, whether or not a closing entry has been written.",
    ],
    empty: statements.empty,
  };
}

async function dayBookReport(
  companyId: string,
  from: string,
  to: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  const first = await listJournalEntries({ companyId, from, to, page: 1 });
  const entries = [...first.rows];

  for (let page = 2; page <= first.pageCount; page += 1) {
    if (entries.length >= MAX_DOCUMENT_ROWS) break;
    const next = await listJournalEntries({ companyId, from, to, page });
    entries.push(...next.rows);
  }

  const truncated = first.total > entries.length;
  const rows = entries.slice(0, MAX_DOCUMENT_ROWS).map((entry) =>
    row({
      date: entry.date,
      entry: entry.entryNumber,
      source: describeSource(entry.source) ?? "Manual",
      narration: entry.narration ?? "",
      reference: entry.referenceNo ?? "",
      amount: entry.total,
    }),
  );

  rows.push(row({ narration: "Total", amount: first.totalDebit }, "total"));

  const notes = [
    first.balanced
      ? "Every entry in this period balances."
      : "At least one entry in this period does not balance.",
  ];
  if (truncated) {
    notes.push(
      `${first.total} entries matched; the first ${MAX_DOCUMENT_ROWS} are shown. Narrow the dates to see the rest.`,
    );
  }

  return {
    period: rangeLabel(from, to),
    columns: [
      DATE("date", "Date"),
      TEXT("entry", "Entry"),
      TEXT("source", "Source"),
      TEXT("narration", "Narration"),
      TEXT("reference", "Reference"),
      MONEY("amount", "Amount"),
    ],
    rows,
    notes,
    empty: first.total === 0,
  };
}

/**
 * A ledger, however it was reached.
 *
 * An account ledger and a party statement are the same document — the same
 * rows, the same running balance, the same opening and closing figures. They
 * differ only in how the account is chosen: directly, or via the receivables
 * or payables control account for one party. So one renderer, and the two
 * adapters below decide only which service call produces it.
 */
function ledgerRows(
  ledger: AccountLedger,
  from: string,
  to: string,
  truncated: boolean,
): Omit<ReportResult, "key" | "title"> {
  const rows = [
    row(
      { narration: "Opening balance", running: ledger.openingBalance },
      "total",
    ),
    ...ledger.rows.map((entry) =>
      row({
        date: entry.date,
        entry: entry.entryNumber,
        source: entry.source ?? "Manual",
        narration: entry.lineNarration ?? entry.narration ?? "",
        party: entry.partyName ?? "",
        debit: entry.debit,
        credit: entry.credit,
        running: entry.running,
      }),
    ),
    row(
      {
        narration: "Movement in the period",
        debit: ledger.periodDebit,
        credit: ledger.periodCredit,
      },
      "total",
    ),
    row(
      { narration: "Closing balance", running: ledger.closingBalance },
      "total",
    ),
  ];

  const notes = [
    `${ledger.account.code} · ${ledger.account.name}${ledger.party ? ` — ${ledger.party.name}` : ""}.`,
    "The running balance is in the account's own direction, so a receivable reads positive when somebody owes money rather than negative.",
    "A reversed entry stays in the ledger beside the entry that cancelled it. Neither is hidden, because a ledger that can be edited is not a ledger.",
  ];
  if (truncated) {
    notes.push(
      `${ledger.total} lines matched; the first ${MAX_DOCUMENT_ROWS} are shown. Narrow the dates to see the rest.`,
    );
  }

  return {
    period: rangeLabel(from, to),
    columns: [
      DATE("date", "Date"),
      TEXT("entry", "Entry"),
      TEXT("source", "Source"),
      TEXT("narration", "Narration"),
      TEXT("party", "Party"),
      MONEY("debit", "Debit"),
      MONEY("credit", "Credit"),
      MONEY("running", "Balance"),
    ],
    rows,
    notes,
    // A ledger is empty only when there is nothing to say at all. No movement
    // in the window is not the same thing: an account carrying a brought-
    // forward balance and no activity this month still has an opening and a
    // closing figure, and that is precisely what somebody opening a dormant
    // account wants to see.
    empty: ledger.total === 0 && Number(ledger.openingBalance) === 0,
  };
}

/** Walks the ledger's pages up to the cap, so a report is the whole window. */
async function wholeLedger(
  load: (page: number) => Promise<AccountLedger>,
): Promise<{ ledger: AccountLedger; truncated: boolean }> {
  const first = await load(1);
  const rows = [...first.rows];

  for (let page = 2; page <= first.pageCount; page += 1) {
    if (rows.length >= MAX_DOCUMENT_ROWS) break;
    rows.push(...(await load(page)).rows);
  }

  return {
    ledger: { ...first, rows: rows.slice(0, MAX_DOCUMENT_ROWS) },
    truncated: first.total > rows.length,
  };
}

async function accountLedgerReport(
  companyId: string,
  accountId: string,
  from: string,
  to: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  const { ledger, truncated } = await wholeLedger((page) =>
    getAccountLedger({ companyId, accountId, from, to, page }),
  );
  return ledgerRows(ledger, from, to, truncated);
}

async function partyStatementReport(
  companyId: string,
  partyId: string,
  partyType: "CUSTOMER" | "SUPPLIER",
  from: string,
  to: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  const { ledger, truncated } = await wholeLedger((page) =>
    partyStatement({ companyId, partyType, partyId, from, to, page }),
  );
  return ledgerRows(ledger, from, to, truncated);
}

// ---------------------------------------------------------------------------
// Business
// ---------------------------------------------------------------------------

async function salesRegisterReport(
  companyId: string,
  from: string,
  to: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  const first = await listSales({ companyId, from, to, page: 1 });
  const sales = [...first.rows];

  for (let page = 2; page <= first.pageCount; page += 1) {
    if (sales.length >= MAX_DOCUMENT_ROWS) break;
    sales.push(...(await listSales({ companyId, from, to, page })).rows);
  }

  const rows = sales.slice(0, MAX_DOCUMENT_ROWS).map((sale) =>
    row({
      date: sale.invoiceDate,
      invoice: sale.invoiceNumber,
      customer: sale.customerName,
      status: sale.status === "VOIDED" ? "Voided" : "Posted",
      taxable: sale.taxableAmount,
      tax: sale.taxAmount,
      total: sale.totalAmount,
    }),
  );

  rows.push(
    row(
      {
        customer: "Posted total",
        taxable: first.postedTaxable,
        tax: first.postedTax,
        total: first.postedTotal,
      },
      "total",
    ),
  );

  const notes = [
    "Voided invoices are listed and excluded from the total — an invoice number that simply vanished is the gap a tax officer asks about.",
  ];
  if (first.total > sales.length) {
    notes.push(
      `${first.total} invoices matched; the first ${MAX_DOCUMENT_ROWS} are shown.`,
    );
  }

  return {
    period: rangeLabel(from, to),
    columns: [
      DATE("date", "Date"),
      TEXT("invoice", "Invoice"),
      TEXT("customer", "Customer"),
      TEXT("status", "Status"),
      MONEY("taxable", "Taxable"),
      MONEY("tax", "Tax"),
      MONEY("total", "Total"),
    ],
    rows,
    notes,
    empty: first.total === 0,
  };
}

async function purchaseRegisterReport(
  companyId: string,
  from: string,
  to: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  const first = await listPurchases({ companyId, from, to, page: 1 });
  const bills = [...first.rows];

  for (let page = 2; page <= first.pageCount; page += 1) {
    if (bills.length >= MAX_DOCUMENT_ROWS) break;
    bills.push(...(await listPurchases({ companyId, from, to, page })).rows);
  }

  const rows = bills.slice(0, MAX_DOCUMENT_ROWS).map((bill) =>
    row({
      date: bill.billDate,
      bill: bill.billNumber,
      reference: bill.supplierBillNo ?? "",
      supplier: bill.supplierName,
      status: bill.status === "VOIDED" ? "Voided" : "Posted",
      itc: bill.itcEligible ? "Claimable" : "In cost",
      taxable: bill.taxableAmount,
      tax: bill.taxAmount,
      total: bill.totalAmount,
    }),
  );

  rows.push(
    row({ supplier: "Posted total", total: first.postedTotal }, "total"),
  );

  const notes = [
    // The figure stopped being a plain accumulation when the headline it comes
    // from started netting debit notes. A note describing a number it no longer
    // describes is worse than no note: this one is printed on a register an
    // accountant reconciles against the GST working paper, which nets the same
    // way, and the two agreeing is the whole point of saying it here.
    `Input tax credit held on posted, eligible bills, less what debit notes gave back: ${first.inputCredit}.`,
    "A bill marked in cost is one whose tax cannot be claimed, so it was landed onto the stock instead.",
  ];
  if (first.total > bills.length) {
    notes.push(
      `${first.total} bills matched; the first ${MAX_DOCUMENT_ROWS} are shown.`,
    );
  }

  return {
    period: rangeLabel(from, to),
    columns: [
      DATE("date", "Date"),
      TEXT("bill", "Bill"),
      TEXT("reference", "Their ref"),
      TEXT("supplier", "Supplier"),
      TEXT("status", "Status"),
      TEXT("itc", "Input tax"),
      MONEY("taxable", "Taxable"),
      MONEY("tax", "Tax"),
      MONEY("total", "Total"),
    ],
    rows,
    notes,
    empty: first.total === 0,
  };
}

async function expensesByCategoryReport(
  companyId: string,
  from: string,
  to: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  const result = await listExpenses({ companyId, from, to, page: 1 });

  const rows = result.byCategory.map((category) =>
    row({ category: category.name, amount: category.total }),
  );

  rows.push(
    row(
      { category: "Total revenue expense", amount: result.postedExpense },
      "total",
    ),
  );

  return {
    period: rangeLabel(from, to),
    columns: [TEXT("category", "Category"), MONEY("amount", "Amount")],
    rows,
    notes: [
      `Capitalised in this period and therefore not a cost: ${result.capitalised}. Something the shop keeps and uses is an asset, not an expense.`,
      `Input tax credit on these expenses: ${result.inputCredit}.`,
      "Voided expenses are excluded.",
    ],
    empty: result.byCategory.length === 0,
  };
}

async function stockOnHandReport(
  companyId: string,
  today: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  const stock = await stockRows(companyId);

  const rows = stock.map((entry) =>
    row({
      sku: entry.sku,
      product: entry.name,
      category: entry.categoryName ?? "",
      unit: entry.unitCode,
      quantity: entry.quantity,
      cost: entry.averageCost,
      value: entry.stockValue,
      status:
        entry.status === "OUT"
          ? "Out of stock"
          : entry.status === "LOW"
            ? "Low"
            : "",
    }),
  );

  const totalValue = stock.reduce(
    (sum, entry) => add(sum, entry.stockValue),
    money(0),
  );
  rows.push(
    row(
      { product: "Total value", value: toStorageString(totalValue) },
      "total",
    ),
  );

  return {
    period: `as at ${dayLabel(today)}`,
    columns: [
      TEXT("sku", "SKU"),
      TEXT("product", "Product"),
      TEXT("category", "Category"),
      TEXT("unit", "Unit"),
      NUMBER("quantity", "Quantity"),
      MONEY("cost", "Unit cost"),
      MONEY("value", "Value"),
      TEXT("status", "Status"),
    ],
    rows,
    notes: [
      "Value is what the books carry the stock at, not what it would sell for.",
      "Only stock-tracked products appear. A service or an untracked item has no position to report.",
    ],
    empty: stock.length === 0,
  };
}

function ageingReport(
  ageing: LedgerAgeing,
  who: string,
  today: string,
): Omit<ReportResult, "key" | "title"> {
  const bucketKeys = Object.keys(ageing.summary.buckets);

  const rows = ageing.parties.map((party) =>
    row({
      party: party.name,
      outstanding: party.outstanding,
      overdue: party.overdue,
      oldest:
        party.oldestOverdueDays === null ? "" : String(party.oldestOverdueDays),
    }),
  );

  rows.push(
    row(
      {
        party: "Total",
        outstanding: ageing.summary.total,
        overdue: ageing.summary.overdue,
      },
      "total",
    ),
  );

  const buckets = bucketKeys
    .map((key) => `${key}: ${ageing.summary.buckets[key] ?? "0"}`)
    .join(" · ");

  return {
    period: `as at ${dayLabel(today)}`,
    columns: [
      TEXT("party", who),
      MONEY("outstanding", "Outstanding"),
      MONEY("overdue", "Overdue"),
      NUMBER("oldest", "Oldest overdue (days)"),
    ],
    rows,
    notes: [
      `By age — ${buckets}.`,
      "Aged from each document's due date, not its date, so nothing is counted late before it is payable.",
    ],
    empty: ageing.parties.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

async function gstSummaryReport(
  companyId: string,
  year: number,
  month: number,
): Promise<Omit<ReportResult, "key" | "title">> {
  const paper = await getGstWorkingPaper({ companyId, year, month });

  const rateRows = (
    label: string,
    rates: ReadonlyArray<{
      ratePercent: string;
      taxableValue: string;
      cgst: string;
      sgst: string;
      igst: string;
      totalTax: string;
    }>,
  ) => [
    row({ line: label }, "group"),
    ...rates.map((rate) =>
      row({
        line: `${rate.ratePercent}%`,
        taxable: rate.taxableValue,
        cgst: rate.cgst,
        sgst: rate.sgst,
        igst: rate.igst,
        tax: rate.totalTax,
      }),
    ),
  ];

  const rows = [
    ...rateRows("Outward supply", paper.outward.byRate),
    row(
      {
        line: "Outward total",
        taxable: paper.outward.total.taxableValue,
        cgst: paper.outward.total.cgst,
        sgst: paper.outward.total.sgst,
        igst: paper.outward.total.igst,
        tax: paper.outward.total.totalTax,
      },
      "total",
    ),
    ...rateRows("Inward supply", paper.inward.byRate),
    row(
      {
        line: "Input credit claimable",
        taxable: paper.inward.eligible.taxableValue,
        cgst: paper.inward.eligible.cgst,
        sgst: paper.inward.eligible.sgst,
        igst: paper.inward.eligible.igst,
        tax: paper.inward.eligible.totalTax,
      },
      "total",
    ),
  ];

  return {
    period: paper.label,
    columns: [
      TEXT("line", "Rate"),
      MONEY("taxable", "Taxable value"),
      MONEY("cgst", "CGST"),
      MONEY("sgst", "SGST"),
      MONEY("igst", "IGST"),
      MONEY("tax", "Total tax"),
    ],
    rows,
    notes: [
      "Prepared for review. Nothing here has been filed with any authority, and this platform cannot file it.",
      paper.reconciliation.agrees
        ? "The register agrees with the ledger for this period."
        : `The register and the ledger disagree — output by ${paper.reconciliation.outputDifference}, input by ${paper.reconciliation.inputDifference}. Resolve that before treating these figures as final.`,
    ],
    empty:
      paper.outward.byRate.length === 0 && paper.inward.byRate.length === 0,
  };
}

// ---------------------------------------------------------------------------

export async function runReport(params: {
  companyId: string;
  key: string;
  period: ReportParams;
}): Promise<ReportResult> {
  const definition = findReport(params.key);
  if (!definition) {
    throw new ReportError("That report does not exist.", "UNKNOWN_REPORT");
  }

  const { companyId } = params;
  const { from, to, year, month, entityId } = params.period;

  const needsRange = definition.period === "range";
  const needsDate = definition.period === "asAt";
  const needsMonth = definition.period === "month";

  if (needsRange && (!from || !to)) {
    throw new ReportError("This report needs a date range.", "BAD_PERIOD");
  }
  if (needsRange && from! > to!) {
    throw new ReportError(
      "The start date is after the end date.",
      "BAD_PERIOD",
    );
  }
  if (needsDate && !to) {
    throw new ReportError("This report needs a date.", "BAD_PERIOD");
  }
  if (needsMonth && (!year || !month)) {
    throw new ReportError("This report needs a month.", "BAD_PERIOD");
  }

  if (definition.entity && !params.period.entityId) {
    throw new ReportError(
      `Choose which ${definition.entity === "account" ? "account" : definition.entity} this report is about.`,
      "MISSING_ENTITY",
    );
  }

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { timezone: true },
  });

  const body = await runBody(
    companyId,
    definition.key as ReportKey,
    { from, to, year, month, entityId },
    businessToday(asBusinessTimezone(company.timezone)),
  );

  return { key: definition.key as ReportKey, title: definition.title, ...body };
}

async function runBody(
  companyId: string,
  key: ReportKey,
  period: ReportParams,
  /**
   * The business's own calendar day, for the two reports that are "as at now"
   * rather than as at a date somebody chose. Read once by the caller so a
   * report and the form that offered its dates agree about what day it is.
   */
  today: string,
): Promise<Omit<ReportResult, "key" | "title">> {
  switch (key) {
    case "trial-balance":
      return trialBalanceReport(companyId, period.from!, period.to!);
    case "profit-and-loss":
      return profitAndLossReport(companyId, period.from!, period.to!);
    case "balance-sheet":
      return balanceSheetReport(companyId, period.to!);
    case "account-ledger":
      return accountLedgerReport(
        companyId,
        period.entityId!,
        period.from!,
        period.to!,
      );
    case "customer-statement":
      return partyStatementReport(
        companyId,
        period.entityId!,
        "CUSTOMER",
        period.from!,
        period.to!,
      );
    case "supplier-statement":
      return partyStatementReport(
        companyId,
        period.entityId!,
        "SUPPLIER",
        period.from!,
        period.to!,
      );
    case "day-book":
      return dayBookReport(companyId, period.from!, period.to!);
    case "sales-register":
      return salesRegisterReport(companyId, period.from!, period.to!);
    case "purchase-register":
      return purchaseRegisterReport(companyId, period.from!, period.to!);
    case "expenses-by-category":
      return expensesByCategoryReport(companyId, period.from!, period.to!);
    case "stock-on-hand":
      return stockOnHandReport(companyId, today);
    case "receivables-ageing":
      return ageingReport(
        await receivablesAgeing(companyId),
        "Customer",
        today,
      );
    case "payables-ageing":
      return ageingReport(await payablesAgeing(companyId), "Supplier", today);
    case "gst-summary":
      return gstSummaryReport(companyId, period.year!, period.month!);
  }
}

export type ReportEntityOption = { id: string; label: string; hint?: string };

/**
 * What a single-subject report can be run against.
 *
 * Read from the tenant's own records, which is also what makes the chosen id
 * safe: a report is only ever run for an entity this company actually has,
 * because the services underneath filter by `companyId` regardless of what
 * arrives in the URL.
 */
export async function reportEntityOptions(
  companyId: string,
  kind: ReportEntityKind,
): Promise<ReportEntityOption[]> {
  if (kind === "account") {
    const accounts = await ledgerAccounts(companyId);
    return accounts.map((account) => ({
      id: account.id,
      label: `${account.code} · ${account.name}`,
      hint: account.used ? undefined : "no postings",
    }));
  }

  const parties = await ledgerParties({
    companyId,
    partyType: kind === "customer" ? "CUSTOMER" : "SUPPLIER",
  });
  return parties.map((party) => ({ id: party.id, label: party.name }));
}
