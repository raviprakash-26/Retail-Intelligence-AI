import "server-only";
import { prisma } from "@/lib/db";
import { add } from "@/lib/money";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  openInvoices,
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
}): Promise<ReminderPreview | null> {
  const customer = await prisma.customer.findFirst({
    where: { id: params.customerId, companyId: params.companyId },
    select: { id: true, name: true, email: true },
  });
  if (!customer) return null;

  const invoices = await openInvoices(prisma, {
    companyId: params.companyId,
    customerId: params.customerId,
  });

  let outstanding = "0";
  let overdue = "0";
  let oldest = 0;
  for (const invoice of invoices) {
    outstanding = add(outstanding, invoice.outstanding).toString();
    if (invoice.daysOverdue > 0) {
      overdue = add(overdue, invoice.outstanding).toString();
      oldest = Math.max(oldest, invoice.daysOverdue);
    }
  }

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
    totalOutstanding: outstanding,
    totalOverdue: overdue,
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
