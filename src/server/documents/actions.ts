"use server";

import { z } from "zod";
import { recordAuditLog } from "@/server/audit/audit-log";
import { fail, ok, type ActionResult } from "@/server/auth/action-result";
import { assertPermission, type CompanyContext } from "@/server/auth/context";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/observability/logger";
import { sendEmail } from "@/server/email/mailer";
import { checkRateLimit } from "@/server/security/rate-limit";
import { requireSameOrigin } from "@/server/security/request-context";
import { creditNoteDocument } from "./credit-note-document";
import { creditNoteEmail, taxInvoiceEmail } from "./document-emails";
import { taxInvoiceDocument } from "./tax-invoice-document";

/**
 * Sending a document to the party it was issued to.
 *
 * **The address is never in the request.** The caller names a document; the
 * recipient is read from the customer record attached to it. There is no
 * parameter that takes an email address, which is what keeps this from being a
 * way to send mail from a trusted domain to anybody at all. A feature that
 * accepts "send this to that address" is an open relay with extra steps,
 * whatever the intent behind it.
 *
 * Gated on the permission that lets somebody read the document rather than a
 * new one. The email carries exactly what the document carries and goes only
 * to the party already named on it, so there is nothing here a reader could not
 * already do by printing the page and handing it over. Fragmenting the
 * permission set further would cost more than it protects.
 *
 * Rate limited per company, because it sends mail to third parties, and
 * written to the append-only log, because a customer asking "why did I get
 * five copies of this" deserves an answer.
 */

const schema = z.object({
  id: z.string().min(1),
});

type Sent = { to: string };

/**
 * Permission and rate limit.
 *
 * The origin check is deliberately *not* in here. It is called at the top of
 * each action instead, where a reader — and the test that walks every action
 * looking for it — can see it without following a helper. A guard hidden one
 * level down is a guard nobody audits.
 */
async function guard(
  permission: "sales.view",
): Promise<
  | { error: ActionResult<never>; context?: undefined }
  | { error?: undefined; context: CompanyContext }
> {
  const context = await assertPermission(permission);

  const limit = await checkRateLimit(
    "DOCUMENT_EMAIL_COMPANY",
    context.company.id,
  );
  if (!limit.allowed) {
    return {
      error: fail(
        "That is more documents than an hour needs. Try again shortly.",
      ),
    };
  }

  return { context };
}

export async function emailTaxInvoiceAction(
  input: unknown,
): Promise<ActionResult<Sent>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const gate = await guard("sales.view");
  if (gate.error) return gate.error;
  const { context } = gate;

  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("That invoice could not be found.");

  const sale = await prisma.sale.findFirst({
    where: { id: parsed.data.id, companyId: context.company.id },
    select: { invoiceNumber: true, customer: { select: { email: true } } },
  });
  if (!sale) return fail("That invoice could not be found.");

  const to = sale.customer?.email?.trim();
  if (!to) {
    // Said plainly rather than silently doing nothing. A shop that thinks it
    // sent an invoice and did not is worse off than one told to add an address.
    return fail(
      "This customer has no email address on record, so there is nowhere to send it. Add one on the customer and try again.",
    );
  }

  const document = await taxInvoiceDocument({
    companyId: context.company.id,
    saleId: parsed.data.id,
  });

  const result = await sendEmail(taxInvoiceEmail({ to, document }));
  if (!result.delivered) {
    logger.error("Invoice email failed", {
      module: "Documents",
      companyId: context.company.id,
      reason: result.reason,
    });
    return fail(
      "That invoice could not be sent just now. Nothing was delivered — try again in a moment.",
    );
  }

  await recordAuditLog({
    action: "sale.invoice_emailed",
    module: "Sales",
    companyId: context.company.id,
    userId: context.user.id,
    actorEmail: context.user.email,
    entityType: "Sale",
    entityId: parsed.data.id,
    metadata: { invoiceNumber: sale.invoiceNumber, to },
  });

  return ok({ to });
}

export async function emailCreditNoteAction(
  input: unknown,
): Promise<ActionResult<Sent>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const gate = await guard("sales.view");
  if (gate.error) return gate.error;
  const { context } = gate;

  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("That credit note could not be found.");

  const note = await prisma.salesReturn.findFirst({
    where: { id: parsed.data.id, companyId: context.company.id },
    select: { returnNumber: true, customer: { select: { email: true } } },
  });
  if (!note) return fail("That credit note could not be found.");

  const to = note.customer?.email?.trim();
  if (!to) {
    return fail(
      "This customer has no email address on record, so there is nowhere to send it. Add one on the customer and try again.",
    );
  }

  const document = await creditNoteDocument({
    companyId: context.company.id,
    returnId: parsed.data.id,
  });

  const result = await sendEmail(creditNoteEmail({ to, document }));
  if (!result.delivered) {
    logger.error("Credit note email failed", {
      module: "Documents",
      companyId: context.company.id,
      reason: result.reason,
    });
    return fail(
      "That credit note could not be sent just now. Nothing was delivered — try again in a moment.",
    );
  }

  await recordAuditLog({
    action: "salesReturn.credit_note_emailed",
    module: "Sales",
    companyId: context.company.id,
    userId: context.user.id,
    actorEmail: context.user.email,
    entityType: "SalesReturn",
    entityId: parsed.data.id,
    metadata: { noteNumber: note.returnNumber, to },
  });

  return ok({ to });
}
