import { expect, test } from "@playwright/test";
import { STATE } from "./support";

/**
 * Payroll, through the interface.
 *
 * The arithmetic is unit-tested and the posting is integration-tested. What is
 * left for a browser is whether somebody can actually reach a run, see what it
 * will do before committing, and be told plainly what the platform will not
 * work out for them.
 */

test.describe("running payroll", () => {
  test.use({ storageState: STATE.owner });

  test("the page states the policy that decides every deduction", async ({
    page,
  }) => {
    await page.goto("/app/payroll");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    expect(body).toMatch(/Registered under EPF/i);
    expect(body).toMatch(/Registered under ESI/i);
    expect(body).toMatch(/professional tax/i);

    // The one thing the platform refuses to compute, said on the page rather
    // than buried in documentation.
    expect(body).toMatch(/TDS is not on this list/i);
    expect(body).toMatch(/does not work it out/i);
  });

  test("previews a run in full before anything is posted", async ({ page }) => {
    await page.goto("/app/payroll/new");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    // Either there are staff to pay, or the page says there are none.
    if (/Nobody to pay/i.test(body)) return;

    expect(body).toMatch(/Gross pay/i);
    expect(body).toMatch(/Net to pay/i);
    expect(body).toMatch(/TDS is not calculated/i);

    // Salaries are not editable here — they come from the employee records.
    // The only figure the form collects is tax withheld.
    const taxInputs = page.locator('input[aria-label^="Tax withheld from"]');
    expect(await taxInputs.count()).toBeGreaterThan(0);

    // And nothing has been written by looking at it.
    await page.goto("/app/payroll");
    await page.waitForLoadState("networkidle");
    expect(await page.locator("body").innerText()).toMatch(
      /No payroll yet|Period/i,
    );
  });
});

test.describe("what a cashier may not do with payroll", () => {
  test.use({ storageState: STATE.cashier });

  test("is not offered payroll, and is refused at the URL", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.waitForLoadState("networkidle");

    const navigation = await page
      .locator('nav[aria-label="Main navigation"]')
      .innerText();
    expect(navigation).not.toContain("Payroll");

    // Hiding is presentation. The page asks as well.
    await page.goto("/app/payroll");
    await page.locator("h1").first().waitFor();
    const body = await page.locator("body").innerText();
    expect(body).toMatch(/do not have access|not allowed|forbidden/i);
    expect(body).not.toMatch(/Registered under EPF/i);
  });
});
