import { expect, test } from "@playwright/test";
import { STATE } from "./support";

/**
 * Roles a business defines for itself.
 *
 * Sold on the pricing page as a Business-plan feature since the beginning, and
 * until now not built at all. These check it exists and that it cannot be used
 * to promote yourself.
 */

test.describe("custom roles", () => {
  test.use({ storageState: STATE.owner });

  test("lists the built-in roles and marks them untouchable", async ({
    page,
  }) => {
    await page.goto("/app/settings/roles");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();

    const body = await page.locator("body").innerText();
    expect(body).toContain("Owner");
    expect(body).toContain("Cashier");
    expect(body).toMatch(/Built in/i);
  });

  test("says which plan building your own comes with, and offers no button that would refuse", async ({
    page,
  }) => {
    // The demo tenant is on Professional — the plan a real signup is given —
    // and custom roles are sold from Business. So this is the state a real
    // person on the popular plan sees, and it is worth asserting directly.
    //
    // The first version of this reached for the create button and called
    // test.skip() when it was absent. That reads as a pass in the report and
    // proves nothing, which is the worse failure of the two: a feature could
    // be deleted outright and the line would stay green.
    await page.goto("/app/settings/roles");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    expect(body).toContain("Custom roles need a higher plan");
    // Named, not hinted at. "Upgrade to unlock" is not an answer to the
    // question somebody actually has, which is which plan and what it costs.
    expect(body).toMatch(/included from Business/i);
    // And what is *not* withheld is said too: the six built-in roles are
    // assignable on every plan, so this is a bound on the feature rather than
    // a wall in front of the page.
    expect(body).toMatch(/assign freely/i);

    // No button that would take a click and then refuse.
    await expect(page.getByRole("button", { name: /new role/i })).toHaveCount(
      0,
    );
  });
});

test.describe("what a cashier may not do with roles", () => {
  test.use({ storageState: STATE.cashier });

  test("is not offered roles, and is refused at the URL", async ({ page }) => {
    await page.goto("/app/settings/business");
    await page.waitForLoadState("networkidle");
    expect(await page.locator("body").innerText()).not.toContain("Roles");

    await page.goto("/app/settings/roles");
    await page.locator("h1").first().waitFor();
    const text = await page.locator("body").innerText();
    expect(text).toMatch(/do not have access|not allowed|forbidden/i);
    expect(text).not.toMatch(/New role|Built in/i);
  });
});
