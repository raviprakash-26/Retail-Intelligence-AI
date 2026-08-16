import { expect, test, type Page } from "@playwright/test";
import { STATE, fill } from "./support";

/**
 * Sending goods back, through the interface.
 *
 * The integration tests prove that a return reverses the right figures. This
 * proves the other half: that the control a shopkeeper actually presses reaches
 * that code, that the credit note appears against the invoice it reverses
 * rather than quietly shrinking it, and that the trial balance still balances
 * afterwards — the one assertion that would catch a return posting a one-sided
 * entry.
 *
 * The spec raises its own invoice rather than borrowing one. The seeded tenant
 * has no sales, and depending on another spec file to have created one would
 * make this pass or fail on the alphabet.
 */

/** Raises an invoice through the form and returns its number. */
async function raiseInvoice(page: Page, quantity: string): Promise<string> {
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

  await fill(page, 'input[name="lines.0.quantity"]', quantity);
  await fill(page, 'input[name="lines.0.rate"]', "50");

  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/app\/sales\/[0-9a-f-]{8}/);
  await page.waitForLoadState("networkidle");

  const heading = await page.locator("h1").first().innerText();
  return heading.split("\n")[0]?.trim() ?? "";
}

test.describe("returning goods against an invoice", () => {
  test.use({ storageState: STATE.owner });

  test("posts a credit note and leaves the books balanced", async ({
    page,
  }) => {
    const invoiceNumber = await raiseInvoice(page, "4");
    expect(invoiceNumber).not.toBe("");

    await page.getByRole("button", { name: "Record return" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The form asks for a quantity and nothing else — no rate, no tax rate, no
    // total. That is the whole trust boundary, and it is stated on the page.
    await expect(dialog).toContainText(/GST is added on top/i);
    await expect(dialog).toContainText(/Can return/i);

    await fill(page, 'input[name="quantities.0"]', "1");
    await dialog.getByRole("button", { name: /Post credit note/i }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    // The invoice names the note that reversed part of it, and says plainly
    // that its own figures were left alone.
    await page.waitForLoadState("networkidle");
    const invoice = await page.locator("body").innerText();
    expect(invoice).toMatch(/Credit notes against this invoice/i);
    expect(invoice).toMatch(/posts its own entry rather than editing/i);
    expect(invoice).toContain(invoiceNumber);
    // Four were sold; the invoice still says four were sold.
    expect(invoice).toContain("₹200.00");

    // --- And the ledger is still a ledger -----------------------------------
    await page.goto("/app/accounting/trial-balance");
    await page.waitForLoadState("networkidle");
    const trial = await page.locator("body").innerText();
    expect(trial).not.toMatch(/out of balance|does not balance/i);
  });

  test("refuses to return more than is left", async ({ page }) => {
    const invoiceNumber = await raiseInvoice(page, "2");
    expect(invoiceNumber).not.toBe("");

    await page.getByRole("button", { name: "Record return" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await fill(page, 'input[name="quantities.0"]', "5");
    await dialog.getByRole("button", { name: /Post credit note/i }).click();

    // Refused, and the dialog stays open with the reason on the field rather
    // than posting a credit note for goods that never left the shop.
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/left to return/i);
  });

  test("the returns list shows the note and the entry behind it", async ({
    page,
  }) => {
    await page.goto("/app/returns?type=sales");
    await page.waitForLoadState("networkidle");

    // Both directions are offered to somebody who may see both modules.
    const listing = await page.locator("body").innerText();
    expect(listing).toMatch(/Credit notes/i);
    expect(listing).toMatch(/Debit notes/i);

    await page.locator('a[href^="/app/returns/sales/"]').first().click();
    await page.waitForURL(/\/app\/returns\/sales\/[0-9a-f-]{8}/);
    await page.waitForLoadState("networkidle");

    const detail = await page.locator("body").innerText();
    expect(detail).toMatch(/Journal entry/i);
    expect(detail).toMatch(/Debits equal credits/i);
    // Contra-revenue, not a smaller sale — visible in the entry itself.
    expect(detail).toMatch(/Sales Returns/i);
    expect(detail).toMatch(/negative supply/i);
  });
});

test.describe("what a cashier may not do with returns", () => {
  test.use({ storageState: STATE.cashier });

  test("sees invoices but is given no way to reverse one", async ({ page }) => {
    await page.goto("/app/sales");
    await page.waitForLoadState("networkidle");

    const link = page
      .locator('a[href^="/app/sales/"]:not([href$="/new"])')
      .first();
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/app\/sales\/[0-9a-f-]{8}/);
    await page.waitForLoadState("networkidle");

    // A cashier holds `sales.view` and neither `sales.return` nor `sales.void`.
    // Neither control is rendered, and the actions refuse either way.
    await expect(
      page.getByRole("button", { name: "Record return" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Void invoice/i }),
    ).toHaveCount(0);
  });
});

test.describe("chasing a customer who owes money", () => {
  test.use({ storageState: STATE.owner });

  test("shows exactly what would be sent before sending it", async ({
    page,
  }) => {
    // A reminder is the shop speaking in its own name. Everything it will say
    // is on screen first — which invoices, how much, how late.
    //
    // On credit, deliberately. A cash sale settles as it is raised, leaves
    // nothing outstanding, and gives the ageing panel no party to offer a
    // reminder for. The first version of this test raised a cash sale and
    // skipped itself, which proves nothing.
    await page.goto("/app/sales/new");
    await page.waitForSelector('button:has-text("Choose a product")');

    const selects = page.locator('button[role="combobox"]');
    await selects.first().click();
    await page.locator('[role="option"]:has-text("Sharma Provision")').click();
    await selects.nth(1).click();
    await page.locator('[role="option"]:has-text("On credit")').first().click();

    await page.locator('button:has-text("Choose a product")').first().click();
    await page.locator('input[placeholder*="Search by name"]').fill("Sugar");
    await page.waitForTimeout(1200);
    await page.locator("[cmdk-item]").first().click();

    await fill(page, 'input[name="lines.0.quantity"]', "3");
    await fill(page, 'input[name="lines.0.rate"]', "400");
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/app\/sales\/[0-9a-f-]{8}/);
    await page.waitForLoadState("networkidle");

    await page.goto("/app/receipts");
    await page.waitForLoadState("networkidle");

    const remind = page
      .getByRole("button", { name: /payment reminder/i })
      .first();
    await expect(remind).toBeVisible();
    await remind.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The restraint is the point, and it is stated where somebody will read it.
    await expect(dialog).toContainText(/no interest, no penalty/i);
    await expect(dialog).toContainText(/Total outstanding/i);
  });
});
