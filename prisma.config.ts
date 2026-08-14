import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * Environment is loaded explicitly here (rather than relying on the CLI's
 * implicit `.env` handling) so that `NODE_ENV=test` picks up `.env.test` and
 * migrations never run against the development database by accident.
 *
 * The file is loaded only if it is there. `.env` is gitignored, so it exists
 * on a developer's machine and nowhere else — and loading it unconditionally
 * made `prisma generate` fail with ENOENT on any environment that supplies its
 * configuration as real environment variables instead: a container build, a
 * fresh clone, and CI, which is where it was found.
 */
const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
const envPath = path.join(process.cwd(), envFile);
if (existsSync(envPath)) {
  process.loadEnvFile?.(envPath);
}

/**
 * `directUrl` exists for deployments behind a connection pooler, where
 * migrations must bypass PgBouncer and talk to Postgres itself. Most
 * deployments have no pooler, and every one of them was being made to set a
 * second variable to the same value as the first — or, if they did not, to
 * watch `prisma migrate deploy` fail validation before it read the schema.
 *
 * Defaulting it to the ordinary connection keeps the pooler case available to
 * anyone who needs it and out of everybody else's way.
 */
process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx --conditions=react-server prisma/seed.ts",
  },
});
