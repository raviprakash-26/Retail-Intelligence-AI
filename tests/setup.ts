import path from "node:path";
import { beforeAll } from "vitest";

/**
 * Global test setup.
 *
 * Loads `.env.test` so the suite never touches the development database, and
 * asserts that fact rather than trusting it — a test run that truncates a
 * developer's working data is a very expensive way to learn about a typo.
 */
process.loadEnvFile?.(path.join(process.cwd(), ".env.test"));

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (url && !/riai_test|_test(\?|$)/.test(url)) {
    throw new Error(
      `Refusing to run tests against "${url}". The test DATABASE_URL must point at a database whose name ends in _test.`,
    );
  }
});
