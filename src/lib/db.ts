import "server-only";
// eslint-disable-next-line no-restricted-imports -- this module *is* the singleton
import { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";

/**
 * Shared Prisma client.
 *
 * Next.js hot-reloads modules in development, which would otherwise open a new
 * connection pool on every edit until PostgreSQL refuses new connections. The
 * client is stashed on `globalThis` to survive reloads.
 *
 * IMPORTANT: nothing outside `src/server/**` should import this directly.
 *
 * **There is no repository layer, and tenant scoping is not automatic.** This
 * comment used to say it was, and pointed at `src/server/db/tenant.ts` — a
 * file that has never existed. That is a worse thing to tell somebody than
 * nothing at all: a reader who believes the client is already scoped writes
 * the one query that is not.
 *
 * What actually keeps one shop out of another's books is that every query
 * names the company itself, by hand, in about five hundred places. That is a
 * discipline rather than a mechanism, so it is checked rather than trusted:
 * `tests/unit/tenant-scoping.test.ts` reads the models out of the schema and
 * fails on any query that can span tenants without naming one, in Prisma calls
 * and in raw SQL alike. A query that genuinely belongs to no tenant — platform
 * administration, or a sign-in flow that happens before a company has been
 * chosen — is listed there with its reason.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log:
      env.NODE_ENV === "development"
        ? [
            { emit: "stdout", level: "warn" },
            { emit: "stdout", level: "error" },
          ]
        : [{ emit: "stdout", level: "error" }],
    errorFormat: env.NODE_ENV === "development" ? "pretty" : "minimal",
  });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * The transaction-scoped client type. Services that must participate in an
 * enclosing transaction accept this rather than the full client, which keeps
 * them from opening a nested (and therefore non-atomic) transaction.
 */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type DbClient = PrismaClient | PrismaTransactionClient;
