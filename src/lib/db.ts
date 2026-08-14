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
 * Tenant scoping is enforced by the repository layer, and a raw client bypasses
 * it. See `src/server/db/tenant.ts`.
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
