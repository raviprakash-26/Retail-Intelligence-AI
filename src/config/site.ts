/**
 * Marketing site content and navigation.
 *
 * Copy lives here rather than inline in components so it can be reviewed as
 * product messaging, kept consistent across pages, and eventually localised
 * without touching layout code.
 */

export const siteConfig = {
  name: "Retail Intelligence AI",
  shortName: "RIAI",
  tagline: "Smart Accounting. Intelligent Auditing. Better Business Decisions.",
  description:
    "Record your transactions once. Retail Intelligence AI generates your accounts, financial statements, GST working, business insights and forecasts automatically.",
  url: "https://retailintelligence.ai",
  supportEmail: "support@retailintelligence.ai",
  salesEmail: "sales@retailintelligence.ai",
} as const;

export const marketingNav = [
  { title: "Features", href: "/features" },
  { title: "Pricing", href: "/pricing" },
  { title: "About", href: "/about" },
  { title: "Contact", href: "/contact" },
] as const;

export const footerNav = [
  {
    title: "Product",
    links: [
      { title: "Features", href: "/features" },
      { title: "Pricing", href: "/pricing" },
      { title: "Create account", href: "/register" },
      { title: "Sign in", href: "/login" },
    ],
  },
  {
    title: "Company",
    links: [
      { title: "About", href: "/about" },
      { title: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Legal",
    links: [
      { title: "Privacy", href: "/privacy" },
      { title: "Terms", href: "/terms" },
      { title: "Security", href: "/security" },
    ],
  },
] as const;

/** The problems this product exists to solve, in the retailer's own words. */
export const problems = [
  {
    title: "Books kept in a notebook",
    description:
      "Sales in one register, purchases in another, expenses on loose slips. By month end nobody can say what actually happened.",
  },
  {
    title: "An accountant you see once a quarter",
    description:
      "Records are handed over in a bag three months late, and any mistake is discovered long after it could have been fixed.",
  },
  {
    title: "Spreadsheets that quietly break",
    description:
      "One dragged formula, one deleted row, and the totals are wrong — with nothing to tell you which figure moved or when.",
  },
  {
    title: "GST that never quite reconciles",
    description:
      "Input credit, output tax, rate slabs and place of supply. Getting it wrong is expensive; checking it by hand takes days.",
  },
  {
    title: "No idea which products actually earn",
    description:
      "Revenue is visible at the counter. Margin after purchase cost, discount and overhead is not.",
  },
  {
    title: "Cash decisions made on a hunch",
    description:
      "Whether you can afford next month's stock order is a guess, because nothing projects what is coming in and going out.",
  },
] as const;

export const workflowSteps = [
  {
    step: "01",
    title: "Enter the transaction once",
    description:
      "A sale, a purchase, an expense, a payment. Plain fields in plain language — no debit and credit columns to fill in.",
  },
  {
    step: "02",
    title: "Accounting happens automatically",
    description:
      "The rules engine turns it into a balanced double-entry journal, updates the ledger, moves stock and records the tax.",
  },
  {
    step: "03",
    title: "Reports are already current",
    description:
      "Trial balance, trading account, P&L, balance sheet, cash flow and GST registers reflect the entry the moment it posts.",
  },
  {
    step: "04",
    title: "AI explains what changed",
    description:
      "Ask why profit moved, which expense grew, what a ratio means. Every answer is built from your own posted figures.",
  },
] as const;

export type FeatureItem = {
  title: string;
  description: string;
  icon: string;
  category: "accounting" | "compliance" | "intelligence" | "operations";
  /** Plan required, matched against `PLAN_DEFINITIONS`. */
  availableFrom: "starter" | "professional" | "business";
};

export const features: readonly FeatureItem[] = [
  {
    title: "Smart Accounting",
    description:
      "Every transaction becomes a balanced journal entry through one central rules engine. Debits equal credits, enforced by the database itself — not by a formula you have to trust.",
    icon: "BookOpenCheck",
    category: "accounting",
    availableFrom: "starter",
  },
  {
    title: "Financial Statements",
    description:
      "Trading account, profit & loss, balance sheet and cash flow, built from the ledger rather than assembled by adding up sales and expenses.",
    icon: "FileSpreadsheet",
    category: "accounting",
    availableFrom: "starter",
  },
  {
    title: "Journal, Ledger & Trial Balance",
    description:
      "The full audit trail, always reconcilable. If the trial balance ever fails to balance, the system says so instead of quietly presenting a statement.",
    icon: "Scale",
    category: "accounting",
    availableFrom: "starter",
  },
  {
    title: "Inventory Management",
    description:
      "Stock moves when you sell and buy — not on a separate screen you have to remember. Valuation, movement history and low-stock alerts included.",
    icon: "Package",
    category: "operations",
    availableFrom: "professional",
  },
  {
    title: "Customer Management",
    description:
      "Outstanding balances, credit limits, invoice history and a per-customer ledger built from the same journal that produces your accounts.",
    icon: "Users",
    category: "operations",
    availableFrom: "starter",
  },
  {
    title: "Supplier Management",
    description:
      "What you owe, to whom, and since when. Bills, payments and ageing, reconciled against the payables control account.",
    icon: "Truck",
    category: "operations",
    availableFrom: "starter",
  },
  {
    title: "GST Preparation",
    description:
      "Sales and purchase registers, input and output tax, and GSTR-1 / GSTR-3B working papers prepared for your review before filing.",
    icon: "ReceiptIndianRupee",
    category: "compliance",
    availableFrom: "professional",
  },
  {
    title: "Tax Preparation",
    description:
      "Revenue, allowable expenses, depreciation and a taxable-income estimate, laid out as a working paper for you and your consultant.",
    icon: "Landmark",
    category: "compliance",
    availableFrom: "professional",
  },
  {
    title: "Business Analytics",
    description:
      "Product and customer profitability, expense growth, inventory turnover and working capital — from posted figures, not estimates.",
    icon: "ChartColumnBig",
    category: "intelligence",
    availableFrom: "professional",
  },
  {
    title: "Revenue Forecasting",
    description:
      "Projections built from your own trading history, shown as a range with its assumptions and limits stated. No invented precision.",
    icon: "TrendingUp",
    category: "intelligence",
    availableFrom: "professional",
  },
  {
    title: "AI Accountant",
    description:
      "Ask about your business in plain language. Answers are assembled from your ledger through defined queries, with the figures and period cited.",
    icon: "MessageSquareText",
    category: "intelligence",
    availableFrom: "professional",
  },
  {
    title: "AI Auditor",
    description:
      "Continuous checks for duplicates, gaps in invoice numbers, negative stock, unusual amounts and GST inconsistencies — flagged as risks to review, never as accusations.",
    icon: "ShieldCheck",
    category: "intelligence",
    availableFrom: "business",
  },
] as const;

export const faqs = [
  {
    question: "Do I need to understand debits and credits to use this?",
    answer:
      "No. You record what happened in ordinary language — you sold rice to a customer for ₹4,500 on credit. The accounting engine works out the double entry behind it. The journal and ledger are there in full when you or your accountant want to look, but you never have to fill them in.",
  },
  {
    question: "Are the financial statements actually reliable?",
    answer:
      "They are derived from the ledger, not from adding up your sales and expenses separately. Every posting is a balanced journal entry, enforced by constraints in the database itself, and the trial balance is validated before any statement is produced. If something does not balance, you get an error rather than a plausible-looking but wrong report.",
  },
  {
    question: "Does the AI make up numbers?",
    answer:
      "It cannot. Profit, GST, ledger balances, the trial balance, statements and ratios are all calculated by application code from your posted transactions. The AI's job is to explain those figures, flag anomalies and answer questions — it reads your data through defined queries and cites what it used. It has no ability to change a financial record.",
  },
  {
    question: "Can it file my GST returns?",
    answer:
      'Not today, and the product will not claim otherwise. It prepares and validates your GSTR-1 and GSTR-3B working papers and shows them marked "Prepared for review". Filing is done by you or your consultant through the official portal.',
  },
  {
    question: "Is my business data separated from other businesses?",
    answer:
      "Yes. Every record belongs to exactly one business, and the separation is enforced in the data-access layer on the server, not by filtering in the browser. A signed-in user can only ever reach data for a business they hold an active membership in.",
  },
  {
    question: "What happens to a transaction I entered by mistake?",
    answer:
      "A draft can be edited freely. Once a transaction is posted it becomes part of your audit trail, so it is corrected by a reversing entry or a void with a stated reason — both recorded and visible. Posted history is never silently rewritten, which is what makes the books defensible.",
  },
  {
    question: "Can my accountant and my staff both use it?",
    answer:
      "Yes. Roles ship for Owner, Manager, Accountant, Cashier, Auditor and Tax Consultant, and each is a bundle of specific permissions you can adjust. A cashier can record counter sales without seeing your profit; an auditor can read everything without being able to change anything.",
  },
  {
    question: "Can I get my data out?",
    answer:
      "Every report exports to PDF, Excel and CSV. It is your ledger — you should never need our permission to take it elsewhere.",
  },
] as const;

/** Honest capability statements. Each maps to something actually implemented. */
export const trustPoints = [
  {
    title: "Double entry, enforced",
    description:
      "Balance is a database constraint, not a convention. An unbalanced entry cannot be written.",
  },
  {
    title: "Exact decimal arithmetic",
    description:
      "Money is stored and calculated as fixed-point decimals. No floating-point drift in your totals.",
  },
  {
    title: "Immutable audit trail",
    description:
      "Posted entries are corrected by reversal, never edited away. The activity log is append-only.",
  },
  {
    title: "Tenant isolation",
    description:
      "Data separation is enforced server-side in the data-access layer, on every query.",
  },
] as const;
