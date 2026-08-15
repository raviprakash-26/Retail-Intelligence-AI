import type { PermissionKey } from "@/lib/rbac/permissions";
import { FEATURE, type FeatureKey } from "@/lib/billing/plans";

/**
 * What reports exist, and what each one needs before it can be run.
 *
 * A report in this product is a *view of figures something else already
 * computed*. Nothing here adds up a column of its own: the trial balance report
 * runs the trial balance service, the profit and loss report runs the
 * statements service, the ageing reports run the ageing service. That is the
 * whole design, and it is the reason the module is a catalogue rather than a
 * pile of queries — a report that computed its own profit would eventually
 * disagree with the profit on the statements page, and there would be no way to
 * tell which of them was right.
 *
 * Each entry declares the two gates it sits behind. `permission` is the
 * module's own permission, so somebody who may read reports but not sales
 * cannot read the sales register by asking for it as a report — the reports
 * permission opens the cabinet, not every drawer in it. `feature` is the
 * subscription gate, checked again on the server when the report is run.
 */

export type ReportCategory = "Accounting" | "Business" | "Compliance";

/**
 * What the report needs to know about time.
 *
 *   • `range`  — activity between two dates: a register, a profit figure.
 *   • `asAt`   — a position on one date: a balance sheet, stock on hand.
 *   • `month`  — one GST period. The working paper is built per return period
 *                and reconciled against that period's ledger, so asking it for
 *                an arbitrary window would mean a different calculation.
 *   • `today`  — a position that is only meaningful now. Ageing is measured
 *                against the current date; asking for "the ageing as at last
 *                March" would need the invoices open *then*, which is a
 *                different and much more expensive question than this answers.
 */
export type ReportPeriodKind = "range" | "asAt" | "month" | "today";

/**
 * What a report reports *on*, when it is not the whole business.
 *
 * Most reports here take a period and nothing else: a trial balance is the
 * trial balance. A ledger is not — it is the ledger *of an account*, and a
 * statement is the statement *of a customer*. Those need a second parameter,
 * and it is a different kind of thing from a date: it is chosen from what the
 * tenant actually has, and the choice is checked against the tenant's own
 * records rather than trusted from the URL.
 *
 * Customers and suppliers are separate kinds rather than one "party", because
 * the two are drawn from different tables, sit behind different permissions,
 * and settle against opposite sides of the ledger.
 */
export type ReportEntityKind = "account" | "customer" | "supplier";

export type ReportDefinition = {
  key: string;
  title: string;
  /** One line, in the terms a shopkeeper uses. */
  description: string;
  category: ReportCategory;
  period: ReportPeriodKind;
  /** Held in addition to `reports.view`. */
  permission: PermissionKey;
  feature?: FeatureKey;
  /** Set when the report is about one account or one party, not everything. */
  entity?: ReportEntityKind;
  /** What the report reads, named so the answer can be checked at its source. */
  source: string;
};

export const REPORTS = [
  {
    key: "trial-balance",
    title: "Trial balance",
    description:
      "Every account with a balance, in two columns that must come to the same figure.",
    category: "Accounting",
    period: "range",
    permission: "accounting.view",
    source: "Trial balance",
  },
  {
    key: "profit-and-loss",
    title: "Profit and loss",
    description:
      "Trading account and profit and loss for the period, down to what the business earned.",
    category: "Accounting",
    period: "range",
    permission: "accounting.statements.view",
    source: "Financial statements",
  },
  {
    key: "balance-sheet",
    title: "Balance sheet",
    description:
      "What the business owns, what it owes and what is left, on one date.",
    category: "Accounting",
    period: "asAt",
    permission: "accounting.statements.view",
    source: "Financial statements",
  },
  {
    key: "account-ledger",
    title: "Account ledger",
    description:
      "Every posting to one account in date order, with the balance after each.",
    category: "Accounting",
    period: "range",
    permission: "accounting.view",
    entity: "account",
    source: "Ledger",
  },
  {
    key: "day-book",
    title: "Day book",
    description:
      "Every journal entry posted in the period, whatever document caused it.",
    category: "Accounting",
    period: "range",
    permission: "accounting.view",
    source: "Journal",
  },
  {
    key: "sales-register",
    title: "Sales register",
    description:
      "Invoices raised in the period, with taxable value, tax and total.",
    category: "Business",
    period: "range",
    permission: "sales.view",
    source: "Sales",
  },
  {
    key: "purchase-register",
    title: "Purchase register",
    description: "Supplier bills recorded in the period, and the tax on them.",
    category: "Business",
    period: "range",
    permission: "purchases.view",
    source: "Purchases",
  },
  {
    key: "expenses-by-category",
    title: "Expenses by category",
    description: "What the business spent in the period, grouped by category.",
    category: "Business",
    period: "range",
    permission: "expenses.view",
    source: "Expenses",
  },
  {
    key: "customer-statement",
    title: "Customer statement",
    description:
      "What one customer was invoiced, what they paid and what is still open.",
    category: "Business",
    period: "range",
    permission: "customers.view",
    entity: "customer",
    source: "Ledger",
  },
  {
    key: "supplier-statement",
    title: "Supplier statement",
    description:
      "What one supplier billed, what was paid and what is still owed.",
    category: "Business",
    period: "range",
    permission: "suppliers.view",
    entity: "supplier",
    source: "Ledger",
  },
  {
    key: "stock-on-hand",
    title: "Stock on hand",
    description:
      "Quantity and value of every tracked product, as the books currently carry it.",
    category: "Business",
    period: "today",
    permission: "inventory.view",
    feature: FEATURE.INVENTORY,
    source: "Inventory",
  },
  {
    key: "receivables-ageing",
    title: "Receivables ageing",
    description:
      "Who owes the business, and how long each amount has been due.",
    category: "Business",
    period: "today",
    permission: "receipts.view",
    source: "Receivables ageing",
  },
  {
    key: "payables-ageing",
    title: "Payables ageing",
    description:
      "Whom the business owes, and how long each amount has been due.",
    category: "Business",
    period: "today",
    permission: "payments.view",
    source: "Payables ageing",
  },
  {
    key: "gst-summary",
    title: "GST summary",
    description:
      "Outward and inward supply by rate, as prepared for review. Not a filing.",
    category: "Compliance",
    period: "month",
    permission: "gst.view",
    feature: FEATURE.GST_PREPARATION,
    source: "GST working paper",
  },
] as const satisfies readonly ReportDefinition[];

export type ReportKey = (typeof REPORTS)[number]["key"];

export const REPORT_KEYS = REPORTS.map((report) => report.key) as ReportKey[];

export function findReport(key: string): ReportDefinition | undefined {
  return REPORTS.find((report) => report.key === key);
}

export function isReportKey(key: string): key is ReportKey {
  return REPORTS.some((report) => report.key === key);
}

export const REPORT_CATEGORIES: readonly ReportCategory[] = [
  "Accounting",
  "Business",
  "Compliance",
];

/** Reports this member may open, grouped for the hub page. */
export function visibleReports(permissions: ReadonlySet<string>): Array<{
  category: ReportCategory;
  reports: ReportDefinition[];
}> {
  if (!permissions.has("reports.view")) return [];

  return REPORT_CATEGORIES.map((category) => ({
    category,
    reports: REPORTS.filter(
      (report) =>
        report.category === category && permissions.has(report.permission),
    ),
  })).filter((group) => group.reports.length > 0);
}
