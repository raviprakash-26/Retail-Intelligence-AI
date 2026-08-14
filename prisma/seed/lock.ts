import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * One lock, held for the length of a seeding transaction.
 *
 * Seeding is idempotent but it is not atomic: every step reads what exists and
 * then writes what does not, and two callers doing that at once both read the
 * absence and both write. Postgres then rejects the loser on a unique index,
 * which is correct of it and useless to us.
 *
 * That never happens when a person runs `npm run db:seed`. It happens
 * constantly in CI, where the integration suite starts a worker per core
 * against a database that was created seconds earlier and each one seeds the
 * platform rows before its first test. The failure is a `role.create` losing a
 * race it should not have been in.
 *
 * `pg_advisory_xact_lock` is taken inside the transaction deliberately. A
 * session-level lock would have to be released by a matching unlock, and
 * Prisma's pool does not promise the release runs on the connection that took
 * it — a lock leaked that way is held until the connection dies. A
 * transaction-scoped lock is released by the commit or the rollback, whichever
 * happens, with no unlock to forget.
 *
 * The key is arbitrary but must be shared by everything that seeds platform
 * rows, so the seeders serialise against each other as well as against copies
 * of themselves.
 */
const PLATFORM_SEED_LOCK = 4_819_2026n;

/** Runs `work` alone, against callers holding the same lock. */
export async function withPlatformSeedLock<T>(
  prisma: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SEED_LOCK}::bigint)`;
      return work(tx);
    },
    // Generous: the whole permission catalogue and every role's grants are
    // written inside it, and a worker that queued behind another has already
    // spent time waiting.
    { timeout: 120_000, maxWait: 120_000 },
  );
}
