import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

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
