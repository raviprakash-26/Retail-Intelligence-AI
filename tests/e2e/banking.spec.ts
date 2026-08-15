import { expect, test } from "@playwright/test";
import { STATE } from "./support";

/**
 * Bank reconciliation, through the interface.
 *
 * The parser, the matcher and the posting are all tested elsewhere. What only a
 * browser can show is the thing the module is actually for: that somebody can
 * upload the file their bank gave them and end up looking at the difference
 * between two sets of figures.
 */

/** A statement in the shape a bank exports, built for the seeded shop. */
const STATEMENT = [
  "Txn Date,Description,Chq/Ref No,Withdrawal Amt,Deposit Amt",
  "05/04/2026,By Cash Deposit,,,25000.00",
  "07/04/2026,NEFT DR-SHARMA TRADERS,234567,12500.50,",
  "10/04/2026,Quarterly bank charges,,236.00,",
].join("\n");

test.describe("reconciling a bank account", () => {
  test.use({ storageState: STATE.owner });

  test("lists the accounts the business holds, without printing the full number", async ({
    page,
  }) => {
    await page.goto("/app/accounting/banking");
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    expect(body).toMatch(/Canara Bank/i);
    // Masked. A page that prints the account number is a page somebody
    // screenshots.
    expect(body).toContain("0456");
    expect(body).not.toContain("0421201000456");

    // And the page says what importing does and does not do.
    expect(body).toMatch(/does not post anything to your books/i);
  });

  test("imports a statement and shows the difference between the two sides", async ({
    page,
  }) => {
    await page.goto("/app/accounting/banking");
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("link", { name: /Canara Bank/i })
      .first()
      .click();
    await page.waitForURL(/\/app\/accounting\/banking\/[0-9a-f-]{8}/);
    await page.waitForLoadState("networkidle");

    // The window is April 2026, which is what the fixture statement covers.
    await page.goto(
      `${page.url().split("?")[0]}?from=2026-04-01&to=2026-04-30`,
    );
    await page.waitForLoadState("networkidle");

    const before = await page.locator("body").innerText();
    if (!/No statement imported yet/i.test(before)) {
      // A previous run already imported it. Re-importing is a no-op by design,
      // and the assertions below still hold, so carry on rather than skip.
      expect(before).toMatch(/Balance as per your books/i);
    }

    await page.getByRole("button", { name: /Import statement/i }).click();
    const dialog = page.locator("[role=dialog]");
    await dialog.getByLabel(/Statement CSV file/i).setInputFiles({
      name: "april.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(STATEMENT, "utf8"),
    });
    await dialog.getByRole("button", { name: /^Import$/ }).click();

    // The result says what happened to every row rather than "done", and the
    // wait is scoped to the dialog: "No statement imported yet" is on the page
    // behind it, so a looser match resolves before the import has run.
    await expect(dialog.getByText(/\d+ lines? imported/i)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /Done|Cancel/ }).click();
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    // The reconciliation statement, in the order a paper one is written.
    expect(body).toMatch(/Balance as per your books/i);
    expect(body).toMatch(/Balance as per the statement/i);
    expect(body).toMatch(/not yet on the statement/i);
    expect(body).toMatch(/not yet in your books/i);
    // And a verdict, either way — never silence.
    expect(body).toMatch(/Reconciled|unexplained/i);
  });

  test("importing the same statement twice adds nothing", async ({ page }) => {
    // The property that makes the importer safe to use: people re-download
    // overlapping ranges constantly.
    await page.goto("/app/accounting/banking");
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("link", { name: /Canara Bank/i })
      .first()
      .click();
    await page.waitForURL(/\/app\/accounting\/banking\/[0-9a-f-]{8}/);
    await page.waitForLoadState("networkidle");

    const importOnce = async () => {
      await page.getByRole("button", { name: /Import statement/i }).click();
      const dialog = page.locator("[role=dialog]");
      await dialog.getByLabel(/Statement CSV file/i).setInputFiles({
        name: "april.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(STATEMENT, "utf8"),
      });
      await dialog.getByRole("button", { name: /^Import$/ }).click();

      // Scoped to the dialog, and to the summary's own wording. Matching
      // "imported" anywhere on the page finds "No statement imported yet"
      // behind the dialog, which is visible immediately — so the assertion
      // passed while the request was still in flight and read an empty result.
      await expect(dialog.getByText(/\d+ lines? imported/i)).toBeVisible({
        timeout: 30_000,
      });
      const text = await dialog.innerText();
      await page.getByRole("button", { name: /Done|Cancel/ }).click();
      await page.waitForLoadState("networkidle");
      return text;
    };

    await importOnce();
    const second = await importOnce();

    // Every line was recognised as one already held.
    expect(second).toMatch(/0 lines imported/i);
    expect(second).toMatch(/already imported/i);
  });

  test("a statement it cannot read is refused without importing half of it", async ({
    page,
  }) => {
    await page.goto("/app/accounting/banking");
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("link", { name: /Canara Bank/i })
      .first()
      .click();
    await page.waitForURL(/\/app\/accounting\/banking\/[0-9a-f-]{8}/);

    await page.getByRole("button", { name: /Import statement/i }).click();
    await page.getByLabel(/Statement CSV file/i).setInputFiles({
      name: "not-a-statement.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Name,Quantity\nSugar,4\n", "utf8"),
    });
    await page.getByRole("button", { name: /^Import$/ }).click();

    // It names what it expected rather than failing silently.
    await expect(
      page.getByText(/No date column found|No amount columns found/i),
    ).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("what a cashier may not do with the bank", () => {
  test.use({ storageState: STATE.cashier });

  test("is not offered reconciliation, and is refused at the URL", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.waitForLoadState("networkidle");

    const navigation = await page
      .locator('nav[aria-label="Main navigation"]')
      .innerText();
    expect(navigation).not.toContain("Bank reconciliation");

    // Hiding is presentation. The page asks as well.
    await page.goto("/app/accounting/banking");
    await page.locator("h1").first().waitFor();
    const body = await page.locator("body").innerText();
    expect(body).toMatch(/do not have access|not allowed|forbidden/i);
    expect(body).not.toMatch(/Canara Bank/i);
  });
});
