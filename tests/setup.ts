import { beforeAll } from "vitest";
import "./load-env";

/**
 * Global test setup.
 *
 * Loads `.env.test` so the suite never touches the development database, and
 * asserts that fact rather than trusting it — a test run that truncates a
 * developer's working data is a very expensive way to learn about a typo.
 *
 * The loading lives in `./load-env` because the client-bundle scan needs the
 * environment without this guard: it opens no database, and running it under
 * this file fails on a `DATABASE_URL` that is perfectly correct for the job it
 * runs in. The assertion below is what actually protects the developer's
 * database, and it runs wherever this file is the setup.
 */

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (url && !/riai_test|_test(\?|$)/.test(url)) {
    throw new Error(
      `Refusing to run tests against "${url}". The test DATABASE_URL must point at a database whose name ends in _test.`,
    );
  }
});
