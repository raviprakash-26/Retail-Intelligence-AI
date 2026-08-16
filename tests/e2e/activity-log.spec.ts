import { expect, test } from "@playwright/test";
import { STATE } from "./support";

/**
 * Reading what has been done.
 *
 * The log has been written to from thirty-three places since the beginning and
 * read from none. This is the first path that reads it back.
 */

test.describe("the activity log", () => {
  test.use({ storageState: STATE.owner });

  test("shows what has been done in this business", async ({ page }) => {
    // Do something that records, then go and find it.
    await page.goto("/app/accounting/periods");
    await page.waitForLoadState("networkidle");

    const closeButtons = page.getByRole("button", { name: /^Close$/ });
    if ((await closeButtons.count()) > 0) {
      await closeButtons.nth((await closeButtons.count()) - 1).click();
      await page.waitForLoadState("networkidle");
    }

    await page.goto("/app/settings/activity");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();

    const body = await page.locator("body").innerText();
    // Why it is worth reading, said where somebody will read it.
    expect(body).toMatch(/can be edited or removed/i);
    // And the machine names are turned into sentences.
    expect(body).toMatch(
      /Closed an accounting period|Exported|Brought data in/i,
    );
  });

  test("filters to one module and starts again from the newest", async ({
    page,
  }) => {
    await page.goto("/app/settings/activity");
    await page.waitForLoadState("networkidle");

    const accounting = page.getByRole("button", {
      name: "Accounting",
      exact: true,
    });
    if ((await accounting.count()) === 0) test.skip();

    await Promise.all([
      page.waitForURL(/module=Accounting/, { timeout: 20_000 }),
      accounting.first().click(),
    ]);
    expect(page.url()).toContain("module=Accounting");
    // A new filter must not carry an old cursor with it.
    expect(page.url()).not.toContain("cursor=");
  });
});

test.describe("what a cashier may not read", () => {
  test.use({ storageState: STATE.cashier });

  test("is not offered the activity log, and is refused at the URL", async ({
    page,
  }) => {
    await page.goto("/app/settings/business");
    await page.waitForLoadState("networkidle");
    expect(await page.locator("body").innerText()).not.toContain("Activity");

    // 200 with the refusal rendered, not 403: the shell has already been sent
    // by the time the nested page calls forbidden(), so the status is
    // committed. What matters is that none of the log is on the page, and
    // that is asserted directly — the same reasoning the trial balance case
    // records.
    await page.goto("/app/settings/activity");
    await page.locator("h1").first().waitFor();

    const text = await page.locator("body").innerText();
    expect(text).toMatch(/do not have access|not allowed|forbidden/i);
    expect(text).not.toMatch(
      /can be edited or removed|Exported a complete copy/i,
    );
  });
});
