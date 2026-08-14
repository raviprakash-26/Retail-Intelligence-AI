import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests, against a production build.
 *
 * Not the dev server. Three of the things these tests are for — the content
 * security policy, static versus dynamic rendering, and the absence of secrets
 * in the client bundle — behave differently under `next dev`, and a suite that
 * passes only there would be checking a build nobody ships.
 *
 * They run against the development database, which holds the seeded demo
 * tenant. That is deliberate: these tests are about whether the product works
 * from the outside, and the seeded shop is the fixture. Anything they create is
 * created through the interface like a person would, and nothing here deletes.
 */

const PORT = Number(process.env.E2E_PORT ?? 3111);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Some environments ship a Chromium and forbid downloading another.
 *
 * Where one is already on disk we use it; anywhere else Playwright resolves its
 * own as usual. Hard-coding the path would break a normal checkout, and
 * ignoring it would make the suite unrunnable in a container that has no
 * network to fetch a browser from.
 */
const PREINSTALLED_CHROMIUM =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const launchOptions = existsSync(PREINSTALLED_CHROMIUM)
  ? { executablePath: PREINSTALLED_CHROMIUM }
  : {};

export default defineConfig({
  testDir: "./tests/e2e",
  // Sequential by default. These share one seeded tenant, and two specs
  // changing the same subscription at once would fail in a way that has
  // nothing to teach anybody.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    launchOptions,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    // Signs in once per role and saves the session. Everything else reuses it:
    // sign-ins are rate limited per account, and a suite that authenticates
    // afresh for every test trips that limit partway through and then fails
    // whichever test happened to cross it.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: /responsive/,
    },
    {
      name: "phone",
      use: { ...devices["Pixel 7"] },
      dependencies: ["setup"],
      testMatch: /responsive/,
    },
  ],

  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
