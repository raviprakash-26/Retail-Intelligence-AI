import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * Environment is loaded explicitly here (rather than relying on the CLI's
 * implicit `.env` handling) so that `NODE_ENV=test` picks up `.env.test` and
 * migrations never run against the development database by accident.
 */
const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
process.loadEnvFile?.(path.join(process.cwd(), envFile));

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx --conditions=react-server prisma/seed.ts",
  },
});
