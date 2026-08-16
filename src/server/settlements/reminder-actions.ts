"use server";

import { z } from "zod";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/observability/logger";
import { recordAuditLog } from "@/server/audit/audit-log";
import { fail, ok, type ActionResult } from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { sendEmail } from "@/server/email/mailer";
import { checkRateLimit } from "@/server/security/rate-limit";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  paymentReminderEmail,
  reminderPreview,
  type ReminderPreview,
} from "./payment-reminder";

/**
 * Sending a customer a reminder about money owed.
 *
 * The same control as the document emails: **there is no address in the
 * request.** The caller names a customer; the address is read off that
 * customer's record. Anything else would be a way to send mail from a trusted
 * domain, under a real business's name, to anybody at all.
 *
 * Gated on `receipts.create` rather than on reading the ageing. Seeing who owes
 * money is a normal part of running a shop; writing to a customer about their
 * debt is the shop speaking to them, and the person allowed to do that is the
 * person who handles money coming in.
 *
 * Rate limited on the same counter as the other outward mail, so a shop cannot
 * be turned into a sending service by a compromised session.
 */

const schema = z.object({ customerId: z.string().min(1) });

export async function reminderPreviewAction(
  input: unknown,
): Promise<ActionResult<ReminderPreview>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("receipts.create");

  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("That customer could not be found.");

  const preview = await reminderPreview({
    companyId: context.company.id,
    customerId: parsed.data.customerId,
  });
  if (!preview) return fail("That customer could not be found.");

  return ok(preview);
}

export async function sendPaymentReminderAction(
  input: unknown,
): Promise<ActionResult<{ to: string; invoices: number }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("receipts.create");

  const limit = await checkRateLimit(
    "DOCUMENT_EMAIL_COMPANY",
    context.company.id,
  );
  if (!limit.allowed) {
    return fail("That is more mail than an hour needs. Try again shortly.");
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("That customer could not be found.");

  const preview = await reminderPreview({
    companyId: context.company.id,
    customerId: parsed.data.customerId,
  });
  if (!preview) return fail("That customer could not be found.");

  const to = preview.customer.email;
  if (!to) {
    return fail(
      "This customer has no email address on record, so there is nowhere to send it. Add one on the customer and try again.",
    );
  }

  // Nothing owed, nothing to ask for. Sending anyway would be a shop writing
  // to a customer who has paid, which is worse than not sending.
  if (preview.invoices.length === 0) {
    return fail(
      "This customer has nothing outstanding, so there is nothing to remind them about.",
    );
  }

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: context.company.id },
    select: { name: true },
  });

  const result = await sendEmail(
    paymentReminderEmail({ to, supplierName: company.name, preview }),
  );
  if (!result.delivered) {
    logger.error("Payment reminder failed", {
      module: "Settlements",
      companyId: context.company.id,
      reason: result.reason,
    });
    return fail(
      "That reminder could not be sent just now. Nothing was delivered — try again in a moment.",
    );
  }

  // The log is where "when did we last chase them" is answered, so the record
  // has to carry enough to answer it without a second store.
  await recordAuditLog({
    action: "customer.payment_reminded",
    module: "Settlements",
    companyId: context.company.id,
    userId: context.user.id,
    actorEmail: context.user.email,
    entityType: "Customer",
    entityId: preview.customer.id,
    metadata: {
      to,
      invoices: preview.invoices.length,
      outstanding: preview.totalOutstanding,
      overdue: preview.totalOverdue,
    },
  });

  return ok({ to, invoices: preview.invoices.length });
}
