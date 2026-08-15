import { expect, test, type Page } from "@playwright/test";
import { CREDIT_NOTE_PARTICULARS } from "@/lib/documents/tax-invoice";
import { fill, STATE } from "./support";

/**
 * The credit note a customer takes away.
 *
 * A credit note is issued under its own rule with its own list of particulars,
 * shorter than an invoice's and carrying one an invoice has no equivalent of:
 * the number and date of the supply it adjusts. The suite walks the rendered
 * document the same way it walks an invoice.
 */

test.describe("issuing a credit note", () => {
  test.use({ storageState: STATE.owner });

  /** Raises an invoice, returns a line of it, and opens the note. */
  async function openCreditNote(page: Page) {
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

    await fill(page, 'input[name="lines.0.quantity"]', "6");
    await fill(page, 'input[name="lines.0.rate"]', "120");
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/app\/sales\/[0-9a-f-]{8}/);
    await page.waitForLoadState("networkidle");

    // The return dialog asks for a quantity and nothing else — the same flow
    // the returns suite drives.
    await page.getByRole("button", { name: "Record return" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await fill(page, 'input[name="quantities.0"]', "2");
    await dialog.getByRole("button", { name: /Post credit note/i }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await page.waitForLoadState("networkidle");

    // The invoice names the note that reversed part of it; follow it, then
    // open the document from the note.
    await page.locator('a[href^="/app/returns/sales/"]').first().click();
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("link", { name: /credit note/i })
      .first()
      .click();
    await page.waitForLoadState("networkidle");
  }

  test("carries every particular its rule asks for", async ({ page }) => {
    await openCreditNote(page);

    for (const particular of CREDIT_NOTE_PARTICULARS) {
      await expect(
        page.locator(`[data-particular="${particular.testId}"]`).first(),
        `${particular.key}: ${particular.requirement}`,
      ).toBeVisible();
    }
  });

  test("names the invoice it adjusts", async ({ page }) => {
    // Without this a buyer cannot match the credit to anything, and the
    // supply it corrects cannot be corrected.
    await openCreditNote(page);
    await expect(
      page.locator('[data-particular="against-invoice"]'),
    ).toContainText(/INV|\/|-/);
  });

  test("says it is a credit note, not an invoice", async ({ page }) => {
    await openCreditNote(page);
    await expect(
      page.locator('[data-particular="document-nature"]'),
    ).toContainText(/credit note/i);
  });
});
