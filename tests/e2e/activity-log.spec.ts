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
    // Deliberately asserts nothing about *which* entries are on the first
    // page. The newest fifty depend on whatever else has run and on the order
    // the seed inserted things, and the first version of this looked for one
    // specific action — it passed alone and failed on a fresh database, which
    // is a test measuring insertion order rather than the feature.
    await page.goto("/app/settings/activity");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();

    const body = await page.locator("body").innerText();
    // Why it is worth reading, said where somebody will read it.
    expect(body).toMatch(/can be edited or removed/i);

    // And that the machine names read as sentences. The demo trades, so money
    // coming in and going out are always somewhere in the newest page.
    expect(body).toMatch(
      /Recorded a sale|Recorded money received|Recorded an expense|Recorded a sales return/i,
    );
  });

  test("filters to one module and starts again from the newest", async ({
    page,
  }) => {
    // Whichever module the newest page happens to offer, not a named one.
    // This asked for "Accounting" and skipped when it was absent, which made
    // it a coin toss on the seed: the same commit produced a pass and a skip
    // on two consecutive runs, and the skip reads as a pass in the report.
    // The filters are built from the entries actually on the page, so the
    // deterministic thing to assert is that filtering by one of them works.
    await page.goto("/app/settings/activity");
    await page.waitForLoadState("networkidle");

    // The row is "Everything" followed by one button per module present in
    // the entries on the page, so the modules are its siblings.
    const row = page
      .getByRole("button", { name: "Everything", exact: true })
      .locator("xpath=..");
    const modules = row
      .getByRole("button")
      .filter({ hasNotText: /^Everything$/ });

    // Asserted rather than skipped past. The demo has traded, so the newest
    // page always carries entries from at least one module; none would mean
    // the log is empty, which is a failure worth seeing.
    await expect(modules.first()).toBeVisible();
    const label = (await modules.first().innerText()).trim();

    await Promise.all([
      page.waitForURL(/module=/, { timeout: 20_000 }),
      modules.first().click(),
    ]);
    expect(page.url()).toContain(`module=${encodeURIComponent(label)}`);
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
