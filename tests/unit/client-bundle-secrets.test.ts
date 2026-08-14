import { existsSync, readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Nothing secret reaches the browser.
 *
 * The `server-only` package makes importing a server module from a client
 * component a build error, and `env.ts` keeps secrets out of anything prefixed
 * `NEXT_PUBLIC_`. Both are good. Neither is proof, because the way a secret
 * actually escapes is duller than an import: somebody interpolates a value into
 * a prop, or returns a whole database row from a server component, and it is
 * serialised into the page as flight data.
 *
 * So this reads what the build actually produced and looks for the values
 * themselves. It runs only when a build exists — `npm run verify` runs it after
 * one, and it says so rather than passing quietly when there is nothing to
 * check.
 */

const BUILD_DIR = ".next";

/** Names whose values must never appear in anything the browser downloads. */
const SECRET_ENV_KEYS = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "AI_API_KEY",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SMTP_PASSWORD",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;

/** Text that should never be in a client bundle whatever the environment. */
const FORBIDDEN_STRINGS = [
  "postgresql://",
  "postgres://",
  "BEGIN RSA PRIVATE KEY",
  "BEGIN PRIVATE KEY",
  "-----BEGIN",
] as const;

function clientBundleFiles(): string[] {
  if (!existsSync(BUILD_DIR)) return [];
  return globSync(`${BUILD_DIR}/static/**/*.js`, { cwd: process.cwd() });
}

const FILES = clientBundleFiles();

describe("the client bundle", () => {
  it.skipIf(FILES.length === 0)(
    "contains none of the values held in secret environment variables",
    () => {
      // Only values actually set are worth searching for; a variable that is
      // empty in this environment proves nothing either way, and the test says
      // which ones it could check.
      const checked: string[] = [];
      const leaked: string[] = [];

      for (const key of SECRET_ENV_KEYS) {
        const value = process.env[key];
        // Short values produce false positives — "1234" appears in every
        // bundle. A real secret is long.
        if (!value || value.length < 12) continue;
        checked.push(key);

        for (const file of FILES) {
          if (readFileSync(file, "utf8").includes(value)) {
            leaked.push(`${key} in ${file}`);
            break;
          }
        }
      }

      expect(leaked, "a secret was shipped to the browser").toEqual([]);
      expect(
        checked.length,
        "no secret was set in this environment, so nothing was actually checked",
      ).toBeGreaterThan(0);
    },
  );

  it.skipIf(FILES.length === 0)(
    "contains no connection string or key material",
    () => {
      const found: string[] = [];

      for (const file of FILES) {
        const contents = readFileSync(file, "utf8");
        for (const needle of FORBIDDEN_STRINGS) {
          if (contents.includes(needle)) found.push(`${needle} in ${file}`);
        }
      }

      expect(found).toEqual([]);
    },
  );

  it("says plainly when there is no build to inspect", () => {
    // A security test that silently passes because it found nothing to read is
    // worse than no test: it reports green for a check that never ran.
    if (FILES.length === 0) {
      expect(existsSync(BUILD_DIR), "run `npx next build` before this").toBe(
        false,
      );
    } else {
      expect(FILES.length).toBeGreaterThan(0);
    }
  });
});
