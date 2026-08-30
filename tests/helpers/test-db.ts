import { PrismaClient } from "@prisma/client";
import { seedPermissionsAndRoles } from "../../prisma/seed/permissions";
import { seedSubscriptionPlans } from "../../prisma/seed/plans";

/**
 * Shared Prisma client for integration tests.
 *
 * The suite runs against `riai_test`, asserted in tests/setup.ts. Migrations
 * are applied by `npm run test:db:setup` before the suite runs, not from
 * inside it — running `prisma migrate` per test file would serialise the
 * whole suite behind a schema lock.
 */
let client: PrismaClient | undefined;

export function testDb(): PrismaClient {
  client ??= new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
    log: [{ emit: "stdout", level: "error" }],
  });
  return client;
}

export async function disconnectTestDb(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

let platformSeeded = false;

/**
 * Ensures permissions, system roles and plans exist. Idempotent and cached.
 *
 * The cache is per process, and vitest gives each worker its own — so this runs
 * once per worker, not once per suite. That is why it asks for the templates
 * only: `syncExistingTenants` walks every company in the database and rewrites
 * its system roles, and a worker doing that while another test has deliberately
 * dropped a permission puts it straight back. Nothing here needs the sweep —
 * every company a test uses is provisioned from the templates as it is created.
 */
export async function ensurePlatformData(): Promise<void> {
  if (platformSeeded) return;
  const prisma = testDb();
  await seedPermissionsAndRoles(prisma, { existingTenants: "skip" });
  await seedSubscriptionPlans(prisma);
  platformSeeded = true;
}

/**
 * Removes a company created by a test, lifting the immutability triggers for
 * the duration of the delete. Mirrors `purgeCompany` but takes the test
 * client rather than the application singleton.
 */
export async function purgeTestCompany(companyId: string): Promise<void> {
  const prisma = testDb();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.allow_financial_purge = 'on'");
    // Mirrors purgeCompany, and has to keep mirroring it. Payslips restrict
    // their employee and nothing orders the two cascades from company against
    // each other; the rest hang off the company with ON DELETE SET NULL, so
    // deleting it detaches them rather than removing them. A test company
    // purged without these leaves rows behind that match no company — which is
    // residue in a database every other test file is using at the same time.
    await tx.payroll.deleteMany({ where: { companyId } });
    await tx.paymentEvent.deleteMany({ where: { companyId } });
    await tx.auditLog.deleteMany({ where: { companyId } });
    await tx.session.deleteMany({ where: { companyId } });
    await tx.company.delete({ where: { id: companyId } });
  });
}

/**
 * Removes users created by a test.
 *
 * Needs the purge flag for the same reason `purgeOrphanedUsers` does: deleting
 * a user nulls its audit-log rows, and that UPDATE is blocked by the
 * append-only trigger.
 */
export async function purgeTestUsers(emails: readonly string[]): Promise<void> {
  if (emails.length === 0) return;
  const prisma = testDb();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL app.allow_financial_purge = 'on'");
    await tx.user.deleteMany({ where: { email: { in: [...emails] } } });
  });
}

/** Unique slug per test so parallel files never collide on the unique index. */
export function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
