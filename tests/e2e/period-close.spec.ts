import { expect, test } from "@playwright/test";
import { STATE } from "./support";

/**
 * Closing the books, from the page.
 *
 * The refusal to post into a closed period existed long before anything could
 * close one, so this is the first path that arms it the way a person does.
 * It closes the oldest open period — not the current one — so the demo stays
 * usable for every other spec in the suite.
 */

test.describe("closing an accounting period", () => {
  test.use({ storageState: STATE.owner });

  test("shows every period and what closing one would freeze", async ({
    page,
  }) => {
    await page.goto("/app/accounting/periods");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: /accounting periods/i }),
    ).toBeVisible();

    const body = await page.locator("body").innerText();
    // The reason the page exists, said where somebody will read it.
    expect(body).toMatch(/stops anything further being posted/i);
    expect(body).toMatch(/Open/);
  });

  test("closes the oldest period and then refuses to close it twice", async ({
    page,
  }) => {
    await page.goto("/app/accounting/periods");
    await page.waitForLoadState("networkidle");

    // Periods list newest first, so the last Close button is the oldest one —
    // the only one that can close while the rest are still open.
    const closeButtons = page.getByRole("button", { name: /^Close$/ });
    const count = await closeButtons.count();
    expect(count).toBeGreaterThan(0);

    const oldest = closeButtons.nth(count - 1);
    await oldest.click();

    await expect(page.getByText(/is closed\./i)).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForLoadState("networkidle");

    // And it now offers to reopen rather than to close again.
    await expect(
      page.getByRole("button", { name: /^Reopen$/ }).first(),
    ).toBeVisible();
  });

  test("asks why before reopening, and says what it means", async ({
    page,
  }) => {
    await page.goto("/app/accounting/periods");
    await page.waitForLoadState("networkidle");

    const reopen = page.getByRole("button", { name: /^Reopen$/ }).first();
    if ((await reopen.count()) === 0) {
      // The previous case closes one; if it has not run, close one here.
      const closeButtons = page.getByRole("button", { name: /^Close$/ });
      await closeButtons.nth((await closeButtons.count()) - 1).click();
      await page.waitForLoadState("networkidle");
    }

    await page
      .getByRole("button", { name: /^Reopen$/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The consequence is stated, not implied.
    await expect(dialog).toContainText(/already have filed on can change/i);
    await expect(dialog).toContainText(/will not be in it/i);

    // And it will not proceed without a reason.
    const confirm = dialog.getByRole("button", { name: /reopen the period/i });
    await expect(confirm).toBeDisabled();

    await dialog
      .getByLabel(/why is it being reopened/i)
      .fill("Correcting a misposted expense");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByText(/is open again/i)).toBeVisible({
      timeout: 20_000,
    });
  });
});
