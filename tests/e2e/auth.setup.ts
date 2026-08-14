import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { test as setup } from "@playwright/test";
import { ADMIN, DEMO, signIn, STATE } from "./support";

/**
 * Sign in once per role, and let every spec reuse it.
 *
 * Not merely an optimisation. Sign-ins are rate limited per account — eight in
 * fifteen minutes — and a suite that signs in afresh for each test trips that
 * limit partway through, then fails whichever test happened to cross it. The
 * failures move around between runs, which reads like flakiness and is in fact
 * the product working exactly as designed.
 *
 * Specs that are *about* signing in still do it themselves. There are two, and
 * two is well inside the budget.
 */

async function save(
  page: Parameters<typeof signIn>[0],
  email: string,
  password: string,
  path: string,
): Promise<void> {
  await signIn(page, email, password);
  mkdirSync(dirname(path), { recursive: true });
  await page.context().storageState({ path });
}

setup("sign in as the shop owner", async ({ page }) => {
  await save(page, DEMO.owner, DEMO.password, STATE.owner);
});

setup("sign in as the cashier", async ({ page }) => {
  await save(page, DEMO.cashier, DEMO.password, STATE.cashier);
});

setup("sign in as the platform administrator", async ({ page }) => {
  await save(page, ADMIN.email, ADMIN.password, STATE.admin);
});
