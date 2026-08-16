import { defineConfig } from "vitest/config";

/**
 * The client-bundle secret scan, on its own.
 *
 * It runs in the job that builds, because it reads what the build emitted,
 * and that job serves the application from the development database. The
 * shared setup refuses any `DATABASE_URL` not ending in `_test` — rightly, it
 * is what stops a suite truncating somebody's working data — so running this
 * under the shared config fails before the scan begins.
 *
 * A configuration of its own says the true thing instead of working around
 * the guard: this test opens no database, so it needs neither the setup that
 * loads one nor the assertion that protects it.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/unit/client-bundle-secrets.test.ts"],
    // The environment but not the database guard. The scan searches the bundle
    // for the values of secret variables and fails when none is set, so
    // without this it would only be runnable where the variables happen to be
    // real — CI, and not a developer's machine.
    setupFiles: ["./tests/load-env.ts"],
    environment: "node",
  },
});
