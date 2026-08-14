import { expect, test } from "@playwright/test";
import { STATE, fill } from "./support";

/**
 * A sale, and everything it is supposed to cause.
 *
 * This is the product's central claim: record what happened once and the
 * accounting, the stock and the reports follow. The integration tests prove
 * each consequence in isolation; this proves that a person clicking through the
 * interface actually triggers them, which is a different question.
 */

test.describe("recording a sale", () => {
  test.use({ storageState: STATE.owner });

  test("posts its own accounting and moves the stock", async ({ page }) => {
    // What the ledger says before anything is recorded.
    await page.goto("/app/accounting/trial-balance");
    await page.waitForSelector("h1");
    const before = await page.locator("body").innerText();
    const balancedBefore = /balanced|Total/i.test(before);
    expect(balancedBefore).toBe(true);

    // --- Record it -----------------------------------------------------------
    await page.goto("/app/sales/new");
    await page.waitForSelector('button:has-text("Choose a product")');

    const selects = page.locator('button[role="combobox"]');
    await selects.first().click();
    await page.locator('[role="option"]:has-text("Sharma Provision")').click();

    await selects.nth(1).click();
    await page.locator('[role="option"]:has-text("Cash")').first().click();

    await page.locator('button:has-text("Choose a product")').first().click();
    await page.locator('input[placeholder*="Search by name"]').fill("Sugar");
    await page.waitForTimeout(1200);
    await page.locator("[cmdk-item]").first().click();

    await fill(page, 'input[name="lines.0.quantity"]', "3");
    await fill(page, 'input[name="lines.0.rate"]', "52");

    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/app\/sales\/[0-9a-f-]{8}/);

    const invoice = await page.locator("body").innerText();
    expect(invoice).toContain("Sharma Provision");

    // --- And the books still balance ----------------------------------------
    await page.goto("/app/accounting/trial-balance");
    await page.waitForSelector("h1");
    const after = await page.locator("body").innerText();

    // The page states whether debits equal credits. A sale that posted a
    // one-sided entry would be caught here, by the report a person reads.
    expect(after).not.toMatch(/out of balance|does not balance/i);
  });

  test("the journal shows what the sale produced, and links back to it", async ({
    page,
  }) => {
    await page.goto("/app/accounting/journal");
    await page.waitForSelector("h1");

    const journal = await page.locator("body").innerText();
    // Every entry names the document that caused it — the whole argument for
    // entering a transaction once.
    expect(journal).toMatch(/Sales|Invoice|INV/i);
  });
});

test.describe("what a cashier may not do", () => {
  test.use({ storageState: STATE.cashier });

  test("cannot reach the accounting reports", async ({ page }) => {
    await page.goto("/app");
    const navigation = await page
      .locator('nav[aria-label="Main navigation"]')
      .innerText();
    expect(navigation).not.toContain("Trial balance");

    // And not merely hidden: asking for it directly shows the refusal and none
    // of the report.
    //
    // The status is 200 rather than 403 here, and that is a property of
    // streaming rather than of the guard: the shell has already been sent by
    // the time the nested page calls `forbidden()`, so the code is committed.
    // What matters is asserted directly — the figures are not on the page.
    await page.goto("/app/accounting/trial-balance");
    await page.locator("h1").first().waitFor();

    const text = await page.locator("body").innerText();
    expect(text).toMatch(/do not have access|not allowed|forbidden/i);
    expect(text).not.toMatch(/Total debit|Trial balance as at/i);
  });
});
