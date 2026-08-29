/**
 * How an activity entry reads.
 *
 * Separate from the query that fetches one because the page renders on the
 * client and the query is server-only. Importing the labels from beside the
 * Prisma call pulled the database client into the browser bundle and the build
 * refused it — correctly. Presentation and query are different jobs, and this
 * is where the seam belongs.
 */

export type ActivityEntry = {
  id: string;
  at: Date;
  /** Who did it, or "Platform administration" where it was done from here. */
  actor: string;
  /** True where the actor was a platform administrator rather than the shop. */
  byPlatform: boolean;
  action: string;
  module: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
};

/**
 * What an action is called in a sentence.
 *
 * The stored values are machine names — `fiscalPeriod.reopened`,
 * `company.data_exported` — and a log nobody can read at a glance is only
 * marginally better than one nobody can read at all. Anything not named here
 * falls back to the raw action, which is honest: a made-up friendly phrase for
 * an action this list has not been taught would be a guess presented as a
 * label, and worse than the machine name.
 */
export const ACTION_LABELS: Record<string, string> = {
  // The everyday ones, which are also the overwhelming majority. A log where
  // ninety per cent of the rows read `sale.posted` is a log somebody skims
  // past — the machine names were fine as a fallback and wrong as the norm.
  "sale.posted": "Recorded a sale",
  "purchase.posted": "Recorded a purchase bill",
  "expense.posted": "Recorded an expense",
  "receipt.posted": "Recorded money received",
  "payment.posted": "Recorded money paid",
  "sale.voided": "Voided a sale",
  "purchase.voided": "Voided a purchase bill",
  "expense.voided": "Voided an expense",
  "receipt.voided": "Voided a receipt",
  "payment.voided": "Voided a payment",
  "auth.sign_in": "Signed in",
  "auth.sign_in_failed": "A sign-in attempt failed",
  "auth.sign_out": "Signed out",
  "auth.password_changed": "Changed a password",
  "auth.verification_resent": "Asked for another verification email",
  "role.created": "Created a role",
  "role.updated": "Changed a role",
  "role.deleted": "Removed a role",
  "company.data_exported": "Exported a complete copy of the business's data",
  "company.data_imported": "Brought data in from a file",
  "customer.payment_reminded": "Sent a payment reminder",
  "sale.invoice_emailed": "Emailed a tax invoice",
  "salesReturn.credit_note_emailed": "Emailed a credit note",
  "fiscalPeriod.closed": "Closed an accounting period",
  "fiscalPeriod.reopened": "Reopened an accounting period",
  "sales_return.created": "Recorded a sales return",
  "purchase_return.created": "Recorded a purchase return",
  "report.exported": "Exported a report",
  "banking.statement_imported": "Imported a bank statement",
  "banking.matched": "Matched a bank line to an entry",
  "banking.unmatched": "Unmatched a bank line",
  "banking.recorded_from_statement": "Recorded a transaction from a statement",
  "banking.account_created": "Added a bank account",
  "payroll.posted": "Posted a payroll run",
  "payroll.cancelled": "Cancelled a payroll run",
  "payroll.policy.updated": "Changed the payroll policy",
  "billing.plan_changed": "Changed the subscription plan",
  "billing.cancelled": "Cancelled the subscription",
  "billing.cancellation_withdrawn": "Withdrew the cancellation",
  "billing.checkout_started": "Started a checkout",
  "billing.payment_failed": "A subscription payment failed",
  "admin.company_status_changed": "Changed this business's account status",
  "admin.plan_updated": "Changed this business's plan",
  "admin.entitlement_override": "Overrode what this business's plan includes",
};

export function describeAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
