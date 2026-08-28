import "server-only";
import { prisma } from "@/lib/db";
import { add, max, money, subtract, toStorageString } from "@/lib/money";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  openInvoices,
  unappliedCredit,
  type OpenDocument,
} from "@/server/settlements/outstanding";
import type { EmailMessage } from "@/server/email/mailer";

/**
 * Asking a customer for money that is owed.
 *
 * The product could already see exactly who owed what and by how many days —
 * the ageing, the advisor, the receivables report — and had no way to act on
 * any of it. A shopkeeper's collection process was remembering to telephone
 * people. Getting paid is the binding constraint on a small retail business far
 * more often than bookkeeping accuracy is, and this is the step that was
 * missing between knowing and being paid.
 *
 * **It states facts and nothing else.** Invoice numbers, what each was for,
 * when it fell due, how many days ago that was, and the total. No interest, no
 * penalty, no threat, and no claim about what happens next — this product does
 * not know what the shop's arrangement with that customer is, and a reminder
 * that invents consequences on a shop's behalf could damage a commercial
 * relationship the shop has spent years building. It is a statement of account
 * with a polite sentence around it.
 *
 * **Nothing is automatic.** Sending is a decision somebody makes, per customer,
 * after seeing exactly what will go. An automatic dunning run that goes out on
 * a wrong figure is not a bug that can be apologised away by email.
 *
 * **Every figure is read from posted documents.** The amounts are the ledger's,
 * not a separate tally kept for chasing — a reminder quoting a figure the books
 * do not carry is the fastest way to lose an argument with a customer who has
 * kept their own records.
 */

export type ReminderPreview = {
  customer: { id: string; name: string; email: string | null };
  /** Everything unpaid, oldest due first — overdue and not yet due alike. */
  invoices: OpenDocument[];
  /**
   * Money received from them that no invoice was named for.
   *
   * Shown rather than quietly netted off the invoices: the customer knows they
   * sent it, and a statement that swallows it into a smaller number is one
   * they cannot check against their own records.
   */
  creditOnAccount: string;
  /** What the invoices come to, less anything paid on account. */
  totalOutstanding: string;
  totalOverdue: string;
  oldestOverdueDays: number;
  /** When this customer was last sent one, so nobody gets three in a day. */
  lastRemindedAt: Date | null;
};

/** What a reminder to this customer would say, without sending anything. */
export async function reminderPreview(params: {
  companyId: string;
  customerId: string;
  /** The instant to age against. Defaults to now; pinned by the tests. */
  asOf?: Date;
}): Promise<ReminderPreview | null> {
  const customer = await prisma.customer.findFirst({
    where: { id: params.customerId, companyId: params.companyId },
    select: { id: true, name: true, email: true },
  });
  if (!customer) return null;

  const invoices = await openInvoices(prisma, {
    companyId: params.companyId,
    customerId: params.customerId,
    asOf: params.asOf,
  });

  let invoiced = money(0);
  let overdue = money(0);
  let oldest = 0;
  for (const invoice of invoices) {
    invoiced = add(invoiced, invoice.outstanding);
    if (invoice.daysOverdue > 0) {
      overdue = add(overdue, invoice.outstanding);
      oldest = Math.max(oldest, invoice.daysOverdue);
    }
  }

  // Money they have sent that no invoice was named for. The ledger has always
  // known about it and the ageing report has always subtracted it; this is the
  // figure the customer is quoted, and it was the one place still adding up
  // invoices as though the payment had not arrived.
  const credit = await unappliedCredit({
    companyId: params.companyId,
    side: "RECEIVABLE",
    partyId: params.customerId,
    documented: invoiced,
  });

  // Taken off what is overdue first, because that is the debt it would have
  // been allocated to and the figure the reminder leads with. Neither total
  // goes below nil — a customer in credit is owed money, not owing a negative
  // amount, and saying so is a conversation rather than a reminder.
  const outstanding = max(subtract(invoiced, credit), 0);
  overdue = max(subtract(overdue, credit), 0);

  // Read off the activity log rather than a column: the log is append-only and
  // already records every send, and a second place to record it is a second
  // place for the two to disagree.
  const last = await prisma.auditLog.findFirst({
    where: {
      companyId: params.companyId,
      action: "customer.payment_reminded",
      entityId: params.customerId,
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  return {
    customer: { ...customer, email: customer.email?.trim() || null },
    invoices,
    creditOnAccount: toStorageString(credit),
    totalOutstanding: toStorageString(outstanding),
    totalOverdue: toStorageString(overdue),
    oldestOverdueDays: oldest,
    lastRemindedAt: last?.createdAt ?? null,
  };
}

/**
 * The reminder, as an email.
 *
 * Plain text carrying the statement itself rather than a link, for the same
 * reason the invoice email does: the person who has to approve the payment is
 * often not the person who received the message, and a URL they cannot open is
 * a reason to put it aside.
 */
/** What the invoices themselves come to, before anything paid on account. */
function sumOutstanding(preview: ReminderPreview): string {
  return toStorageString(
    add(...preview.invoices.map((invoice) => invoice.outstanding)),
  );
}

export function paymentReminderEmail(params: {
  to: string;
  supplierName: string;
  preview: ReminderPreview;
}): EmailMessage {
  const { preview } = params;

  const rows = preview.invoices.map((invoice) => {
    const due = `due ${formatDate(new Date(invoice.dueDate), { style: "long" })}`;
    const late =
      invoice.daysOverdue > 0
        ? ` — ${invoice.daysOverdue} ${invoice.daysOverdue === 1 ? "day" : "days"} ago`
        : " — not yet due";
    return `  ${invoice.number}  ${formatCurrency(invoice.outstanding)}  (${due}${late})`;
  });

  const overdue = Number(preview.totalOverdue) > 0;

  return {
    to: params.to,
    subject: overdue
      ? `Payment reminder from ${params.supplierName}`
      : `Statement of account from ${params.supplierName}`,
    text: [
      `Dear ${preview.customer.name},`,
      "",
      overdue
        ? `This is a reminder that ${formatCurrency(preview.totalOverdue)} is past its due date on your account with ${params.supplierName}.`
        : `Here is your current account with ${params.supplierName}.`,
      "",
      "UNPAID INVOICES",
      ...rows,
      "",
      // Stated on its own line rather than folded into the total. They know
      // they sent it, and a statement they cannot reconcile against their own
      // records is the one that starts the argument.
      ...(Number(preview.creditOnAccount) > 0
        ? [
            `Invoiced: ${formatCurrency(
              rows.length === 0 ? 0 : sumOutstanding(preview),
            )}`,
            `Less payment received, not yet applied to an invoice: ${formatCurrency(preview.creditOnAccount)}`,
            "",
          ]
        : []),
      `Total outstanding: ${formatCurrency(preview.totalOutstanding)}`,
      ...(overdue
        ? [`Of which past due: ${formatCurrency(preview.totalOverdue)}`]
        : []),
      "",
      // No interest, no penalty, no "failing which". The shop's arrangement
      // with this customer is not something this product knows.
      "If any of this does not match your records, please reply and we will",
      "check it against ours. If payment is already on its way, thank you —",
      "please ignore this message.",
      "",
      params.supplierName,
    ].join("\n"),
  };
}
