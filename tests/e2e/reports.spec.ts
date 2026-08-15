import { expect, test } from "@playwright/test";
import { STATE } from "./support";

/**
 * Reports, through the interface.
 *
 * The integration suite proves each report agrees with the service it reports.
 * This proves the two things that only a browser can: that a person can reach
 * one and read it, and that the file they download is the same figures rather
 * than a second rendering of them.
 */

test.describe("running a report", () => {
  test.use({ storageState: STATE.owner });

  test("the hub lists what this business can run, and says where each comes from", async ({
    page,
  }) => {
    await page.goto("/app/reports");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    expect(body).toContain("Trial balance");
    expect(body).toContain("Profit and loss");
    expect(body).toContain("Sales register");

    // Each card names the module the figures come from — the whole claim of
    // the module is that it reports what something else computed.
    expect(body).toMatch(/Financial statements/i);
    expect(body).toMatch(/Accounting/);
    expect(body).toMatch(/Business/);
  });

  test("the trial balance report is a trial balance, and says whether it balances", async ({
    page,
  }) => {
    await page.goto("/app/reports/trial-balance");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: "Trial balance" }),
    ).toBeVisible();

    const body = await page.locator("body").innerText();
    expect(body).toContain("Debit");
    expect(body).toContain("Credit");
    expect(body).toMatch(/Debits equal credits|Out of balance/i);
    // A period is stated. A report whose window is a guess is not a report.
    expect(body).toMatch(/\d{4}/);
  });

  test("exports the figures that are on the page", async ({ page }) => {
    await page.goto("/app/reports/trial-balance");
    await page.waitForLoadState("networkidle");

    const href = await page
      .getByRole("link", { name: /Export CSV/i })
      .getAttribute("href");
    expect(href).toBeTruthy();

    const response = await page.request.get(href!);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/csv");
    expect(response.headers()["content-disposition"]).toContain(
      "trial-balance-",
    );

    const csv = await response.text();
    // The report names itself and its period in the file, because the file is
    // the copy that travels.
    expect(csv).toContain("Trial balance");
    expect(csv).toMatch(/Account,Debit,Credit/);
    // Storage figures, not rendered ones — a spreadsheet cannot add up "₹1,000".
    expect(csv).not.toContain("₹");
  });

  test("a report about one subject asks which, before showing figures", async ({
    page,
  }) => {
    await page.goto("/app/reports/account-ledger");
    await page.waitForLoadState("networkidle");

    // Nothing is auto-selected: presenting the first account's balances as an
    // answer to a question nobody asked would be worse than asking.
    const body = await page.locator("body").innerText();
    expect(body).toMatch(/Choose an account/i);
    expect(body).not.toMatch(/Opening balance/i);
    // And nothing to export until there is something to export.
    await expect(page.getByRole("link", { name: /Export CSV/i })).toHaveCount(
      0,
    );

    // Pick one, and the ledger appears.
    // By id rather than by label: the shell's user menu is also labelled
    // "Account menu for …", and a label match finds both.
    await page.locator("#entity").click();
    // An account the seeded shop has actually posted to, so the ledger has
    // something in it rather than legitimately reporting nothing.
    await page.getByRole("option", { name: /Cash/i }).first().click();

    // Choosing re-renders on the server through a client navigation, so there
    // is no load event to wait on — these assertions retry until it lands.
    await page.waitForURL(/entity=/);
    // `.first()` because the Cash ledger also contains a posted line narrated
    // "Opening balance" — the label row and a real entry both say it, which is
    // correct and would otherwise trip strict mode.
    await expect(page.getByText(/Opening balance/i).first()).toBeVisible();
    await expect(page.getByText(/Closing balance/i).first()).toBeVisible();
    await expect(
      page.getByText(/running balance is in the account/i),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Export CSV/i })).toHaveCount(
      1,
    );
  });

  test("a report with nothing in it says so rather than showing an empty grid", async ({
    page,
  }) => {
    // A window before the business existed.
    await page.goto(
      "/app/reports/sales-register?from=2000-01-01&to=2000-12-31",
    );
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    expect(body).toMatch(/Nothing to report/i);
  });

  test("refuses a period that runs backwards, without inventing figures", async ({
    page,
  }) => {
    await page.goto("/app/reports/trial-balance?from=2026-12-31&to=2026-01-01");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    expect(body).toMatch(/start date is after the end date/i);
    expect(body).not.toContain("Debits equal credits");
  });

  test("a report that does not exist says so, and shows no figures", async ({
    page,
  }) => {
    // The status is 200 rather than 404 here, and that is a property of
    // streaming rather than of the guard: the shell has already been sent by
    // the time the nested page calls `notFound()`, so the code is committed.
    // What matters is asserted directly — there is no report on the page.
    await page.goto("/app/reports/not-a-report");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    expect(body).toMatch(/could not find that page/i);
    expect(body).not.toContain("Debits equal credits");
    expect(body).not.toMatch(/Export CSV/i);
  });
});

test.describe("what a cashier may not do with reports", () => {
  test.use({ storageState: STATE.cashier });

  test("is not offered reports, and is refused at the URL", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.waitForLoadState("networkidle");

    const navigation = await page
      .locator('nav[aria-label="Main navigation"]')
      .innerText();
    expect(navigation).not.toContain("Reports");

    // Hiding is presentation. The page asks as well.
    await page.goto("/app/reports");
    await page.locator("h1").first().waitFor();
    const body = await page.locator("body").innerText();
    expect(body).toMatch(/do not have access|not allowed|forbidden/i);
  });

  test("cannot download a report by asking the export route for one", async ({
    page,
  }) => {
    // The export is a second door into the same cabinet, and it is locked with
    // the same key. A cashier holds neither `reports.view` nor `reports.export`.
    const response = await page.request.get(
      "/app/reports/trial-balance/export?from=2000-01-01&to=2030-01-01",
    );
    expect(response.status()).toBe(403);
    const body = await response.text();
    expect(body).not.toMatch(/Debit,Credit/);
  });
});
