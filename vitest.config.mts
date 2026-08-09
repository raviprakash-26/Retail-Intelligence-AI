import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Path aliases come from tsconfig.json, so `@/…` resolves identically in
    // the app build and in tests.
    tsconfigPaths: true,
    alias: {
      // See tests/stubs/server-only.ts for why this alias exists.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    // Unit tests run in node; component tests opt into jsdom via a docblock
    // pragma (`@vitest-environment jsdom`) so the pure accounting suites stay
    // fast and free of DOM globals.
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/lib/**", "src/server/**"],
      exclude: ["**/*.test.ts", "**/index.ts"],
      thresholds: {
        // Raised progressively as the accounting engine lands in Phase 10.
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },
  },
});
