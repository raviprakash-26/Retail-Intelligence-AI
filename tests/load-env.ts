import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads `.env.test` if it is there.
 *
 * Split out of `tests/setup.ts` so the client-bundle scan can have the
 * environment without the database guard that sits beside it. That test opens
 * no database, but it does search the built bundle for the *values* of secret
 * variables — and it fails rather than passes when none is set, so without
 * this it could only run somewhere the variables happen to be real. CI is such
 * a place and a developer's machine is not, which is a bad way for a security
 * check to behave.
 */
export function loadTestEnv(): void {
  // Gitignored, and CI passes the variables directly instead.
  const envPath = path.join(process.cwd(), ".env.test");
  if (existsSync(envPath)) {
    process.loadEnvFile?.(envPath);
  }
}

loadTestEnv();
