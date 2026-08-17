import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Tables a company delete cannot reach on its own, and why.
 *
 * The purge deletes the company row and lets the database cascade. A table
 * whose company relation is `SET NULL` is detached rather than deleted, and
 * one with no company relation is never reached at all — either way the rows
 * outlive the business, matching no company afterwards, so invisible to every
 * tenant-scoped query and beyond any ordinary cleanup.
 *
 * A test reads this list against the schema and fails when a company-scoped
 * table is in neither category, so a table added later cannot quietly become
 * the next thing that survives erasure.
 */
export const PURGED_EXPLICITLY: Record<string, string> = {
  Payroll:
    "A payslip references its employee with ON DELETE RESTRICT, and nothing orders the employee cascade against the payroll one, so the runs go first to free them.",
  PaymentEvent:
    "No foreign key to companies at all — a webhook can name an order nobody recognises, and such a row still has to be recordable — so a cascade would never reach it.",
  AuditLog:
    "SET NULL, because `userId` is SET NULL for a good reason: removing a person must not destroy the record of what they did, which belongs to the business. Erasing the business is the case where the record should go.",
  Session:
    "SET NULL like the audit log, and a session outliving the company it acted within keeps the IP address and user agent it was opened with.",
};

/**
 * Permanently erases a tenant and every record belonging to it.
 *
 * This is the only supported way to delete financial history. Posted journal
 * entries and audit-log rows are protected by database triggers; this function
 * lifts that protection for the duration of one transaction by setting a
 * session-local flag the triggers check.
 *
 * Reach for this only where erasure is genuinely required — a data-deletion
 * request, or resetting the demo tenant. Ordinary corrections use a reversing
 * entry or a void, both of which preserve the trail.
 */
export async function purgeCompany(companyId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // SET LOCAL scopes the permission to this transaction, so it cannot leak
    // onto a pooled connection and quietly authorise an unrelated delete.
    await tx.$executeRaw(
      Prisma.sql`SET LOCAL app.allow_financial_purge = 'on'`,
    );

    // Payroll first, and explicitly.
    //
    // A payslip references its employee with ON DELETE RESTRICT, which is the
    // right rule everywhere else: somebody who has been paid cannot be erased
    // from under the record of paying them. Deleting the company cascades to
    // employees and to payroll runs independently, and nothing orders those
    // two against each other — so the employee delete can reach the constraint
    // before the run that owns the payslip has gone.
    //
    // Clearing the runs here removes their items by cascade and leaves the
    // employees free. The restriction stays in force for every ordinary
    // delete, which is the point of having it.
    await tx.payroll.deleteMany({ where: { companyId } });

    // Payment events, explicitly.
    //
    // The table has no foreign key to companies — a webhook can arrive naming
    // an order nobody recognises, and a row that belongs to no tenant still has
    // to be recordable. So a cascade would never reach these, and erasing a
    // business would leave behind what it paid and when. Only the rows actually
    // attributed to this company go; unattributed ones are not their data.
    //
    // The append-only trigger refuses a DELETE unless the purge flag set above
    // is on, which is the same escape hatch audit_logs uses.
    await tx.paymentEvent.deleteMany({ where: { companyId } });

    // The activity log and any live sessions, explicitly.
    //
    // Both hang off the company with ON DELETE SET NULL, so deleting it
    // detached them instead of removing them and every row survived the one
    // operation this product offers for erasing a business. What survived was
    // not bookkeeping either: an audit row carries `actorEmail`, `ipAddress`,
    // `userAgent` and a before-and-after payload, so a data-deletion request
    // left behind the personal data of everybody who had worked there —
    // matching no company afterwards, so invisible to every tenant-scoped
    // query and out of reach of any ordinary cleanup.
    //
    // Deleted here rather than by changing the column to CASCADE, because
    // SET NULL is right for the other half of the same row: `userId` is
    // SET NULL so that removing a person does not destroy the record of what
    // they did, which belongs to the business rather than to them. Erasing the
    // business is the case where the record should go, and saying so here
    // keeps both rules visible next to each other.
    //
    // The append-only trigger refuses these deletes too, under the same flag.
    await tx.auditLog.deleteMany({ where: { companyId } });
    await tx.session.deleteMany({ where: { companyId } });

    await tx.company.delete({ where: { id: companyId } });
  });
}

/**
 * Deletes users who are not members of any remaining company.
 *
 * Called after a purge: an account with no tenant left to belong to has no way
 * to sign in to anything, and keeping it serves no purpose.
 *
 * This needs the same escape hatch as `purgeCompany`. `audit_logs.userId` is
 * ON DELETE SET NULL, so removing a user *updates* audit rows — and the
 * append-only trigger rejects an UPDATE just as firmly as a DELETE.
 */
export async function purgeOrphanedUsers(
  emails: readonly string[],
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SET LOCAL app.allow_financial_purge = 'on'`,
    );
    const result = await tx.user.deleteMany({
      where: {
        email: { in: [...emails] },
        memberships: { none: {} },
      },
    });
    return result.count;
  });
}
