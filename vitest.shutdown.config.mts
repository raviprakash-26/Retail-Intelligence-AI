import { defineConfig } from "vitest/config";

/**
 * The graceful-shutdown test, on its own.
 *
 * It runs in the job that builds, for the same reason the client-bundle scan
 * does: it starts the artefact the build produced. It cannot be proved any
 * other way. The drain is a property of a real process receiving a real signal
 * — which handler wins, whether the timer holds the event loop, whether the
 * readiness route and the shutdown handler are looking at the same flag. Every
 * one of those is invisible to a test that imports the modules and calls them,
 * and every one of them was wrong.
 *
 * A configuration of its own for the same reason as the bundle scan: this test
 * opens no database of its own — it hands one to the child process — so it
 * needs neither the shared setup nor the `_test` guard that setup enforces.
 * The server under test is the development database's, which is what the
 * browser job already runs.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/unit/graceful-shutdown.test.ts"],
    setupFiles: ["./tests/load-env.ts"],
    environment: "node",
    // Booting a production server, draining it and waiting for it to exit does
    // not fit in the default timeout, and the drain window is the point.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One server, one port, one signal. Run in sequence or they fight over it.
    fileParallelism: false,
  },
});
