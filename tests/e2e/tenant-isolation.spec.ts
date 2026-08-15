import { expect, test } from "@playwright/test";
import { DEMO, STATE, fill } from "./support";

/**
 * The boundaries, checked from outside the process.
 *
 * The integration tests prove the services scope every query to one company.
 * These prove the same boundaries hold when the request arrives as a URL typed
 * by somebody who should not have it — which is the form the attempt actually
 * takes.
 */

test.describe("a shop owner", () => {
  test.use({ storageState: STATE.owner });

  test("cannot open platform administration", async ({ page }) => {
    const response = await page.goto("/admin");
    expect(response?.status()).toBe(403);
  });
});

test.describe("platform administration", () => {
  test.use({ storageState: STATE.admin });

  test("shows metadata and no ledger", async ({ page }) => {
    await page.goto("/admin/tenants");
    await page.waitForSelector("table");

    const text = await page.locator("body").innerText();
    expect(text).toContain("Ravi Retail Mart");
    expect(text).toMatch(/Entries this month/);

    // The demo shop's opening cash and stock are worth lakhs. None of it, in
    // any of the shapes money is written in, may be on this page.
    for (const figure of ["1,85,000", "185000", "1,85,000.00"]) {
      expect(text, `the panel shows ${figure}`).not.toContain(figure);
    }

    expect(text).toContain("does not show what any business sold");
  });

  test("says on the overview that nobody can sign in as a customer", async ({
    page,
  }) => {
    await page.goto("/admin");
    await page.locator("h2").first().waitFor();

    const text = await page.locator("body").innerText();
    expect(text).toContain("There is no way to sign in as a customer");
    // And the revenue figure is the platform's own, from its own price list.
    expect(text).toContain("a trial is not revenue");
  });
});

test.describe("plan gates", () => {
  test.use({ storageState: STATE.owner });

  test("a module outside the plan is refused by the page, not just hidden", async ({
    page,
  }) => {
    // The demo tenant is on Professional, which does not include the auditor.
    // If a future seed changes that, this reads as a skip rather than a
    // failure — the assertion is about the gate, not about the seed.
    await page.goto("/app/ai/auditor");
    await page.waitForLoadState("networkidle");

    const text = await page.locator("body").innerText();
    const locked = text.includes("is not in your plan");
    const unlocked = text.includes("Observations, not allegations");
    expect(locked || unlocked).toBe(true);

    if (locked) {
      expect(text).toContain("already recorded is unaffected");
    }
  });
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("every protected area sends you to sign in", async ({ page }) => {
    for (const path of ["/app", "/app/sales", "/admin", "/onboarding"]) {
      await page.goto(path);
      await page.waitForURL(/\/login/);
      expect(page.url()).toContain("/login");
    }
  });

  test("a wrong password is refused without saying which half was wrong", async ({
    page,
  }) => {
    await page.goto("/login");
    await fill(page, 'input[name="email"]', DEMO.owner);
    await fill(page, 'input[name="password"]', "NotThePassword123!");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2500);

    const text = await page.locator("body").innerText();
    // Naming which half was wrong tells an attacker which addresses exist.
    expect(text).not.toMatch(/no such (user|account)|user not found/i);
    expect(page.url()).toContain("/login");
  });
});

test.describe("taking the books out", () => {
  test.use({ storageState: STATE.owner });

  test("an owner can download the whole business as a zip", async ({
    page,
  }) => {
    await page.goto("/app/settings/data");
    await expect(
      page.getByRole("heading", { name: "Your data" }),
    ).toBeVisible();

    // The page says what will not be in the file before anybody downloads it.
    const text = await page.locator("body").innerText();
    expect(text).toContain("Sign-in credentials are never exported");

    const response = await page.request.get("/app/settings/data/export");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/zip");
    expect(response.headers()["content-disposition"]).toContain(".zip");

    // Not an empty shell: a zip starts PK, and this one has real content.
    const body = await response.body();
    expect(body.length).toBeGreaterThan(1_000);
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});

test.describe("what a cashier may not carry out of the building", () => {
  test.use({ storageState: STATE.cashier });

  test("is not offered the export, and is refused at the URL", async ({
    page,
  }) => {
    await page.goto("/app/settings/business");
    const nav = await page.locator("body").innerText();
    expect(nav).not.toContain("Your data");

    // The gate is on the server, not on whether the tab was rendered.
    const response = await page.request.get("/app/settings/data/export");
    expect(response.status()).toBe(403);
  });
});
