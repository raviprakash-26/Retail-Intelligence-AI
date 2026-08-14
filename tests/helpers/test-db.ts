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

/** Ensures permissions, system roles and plans exist. Idempotent and cached. */
export async function ensurePlatformData(): Promise<void> {
  if (platformSeeded) return;
  const prisma = testDb();
  await seedPermissionsAndRoles(prisma);
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
