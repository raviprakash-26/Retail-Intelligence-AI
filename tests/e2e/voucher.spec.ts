import { expect, test } from "@playwright/test";
import { STATE } from "./support";

/**
 * Proof that money changed hands.
 *
 * The demo now settles real invoices, so both directions can be opened from a
 * record that exists rather than one the test has to create first.
 */

test.describe("what a customer takes away when they pay", () => {
  test.use({ storageState: STATE.owner });

  test("a receipt voucher names the payer, the amount and what it settled", async ({
    page,
  }) => {
    await page.goto("/app/receipts");
    await page.waitForLoadState("networkidle");

    await page
      .locator('a[href^="/app/receipts/"]:not([href$="/new"])')
      .first()
      .click();
    await page.waitForLoadState("networkidle");

    await page
      .getByRole("link", { name: /voucher/i })
      .first()
      .click();
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-particular="document-nature"]'),
    ).toContainText(/receipt voucher/i);
    await expect(
      page.locator('[data-particular="counterparty-block"]'),
    ).toContainText(/received from/i);
    await expect(page.locator('[data-particular="amount"]')).toContainText("₹");
    await expect(
      page.locator('[data-particular="amount-in-words"]'),
    ).toContainText(/Rupees/);
    await expect(page.locator('[data-particular="allocations"]')).toBeVisible();
    // The shop signs the receipt it issues.
    await expect(page.locator('[data-particular="signature"]')).toContainText(
      /authorised signatory/i,
    );
  });

  test("a payment voucher asks the recipient to sign, not the shop", async ({
    page,
  }) => {
    // The asymmetry is the point: a payment voucher is worth having because
    // the supplier acknowledged the cash, not because our ledger says so.
    await page.goto("/app/payments");
    await page.waitForLoadState("networkidle");

    await page
      .locator('a[href^="/app/payments/"]:not([href$="/new"])')
      .first()
      .click();
    await page.waitForLoadState("networkidle");

    await page
      .getByRole("link", { name: /voucher/i })
      .first()
      .click();
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator('[data-particular="document-nature"]'),
    ).toContainText(/payment voucher/i);
    await expect(
      page.locator('[data-particular="counterparty-block"]'),
    ).toContainText(/paid to/i);
    await expect(page.locator('[data-particular="signature"]')).toContainText(
      /signature of the recipient/i,
    );
  });

  test("the application shell is left off the printed page", async ({
    page,
  }) => {
    await page.goto("/app/receipts");
    await page.waitForLoadState("networkidle");
    await page
      .locator('a[href^="/app/receipts/"]:not([href$="/new"])')
      .first()
      .click();
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("link", { name: /voucher/i })
      .first()
      .click();
    await page.waitForLoadState("networkidle");

    await page.emulateMedia({ media: "print" });
    await expect(page.locator('[data-print="hide"]')).toBeHidden();
    await expect(page.locator('[data-particular="amount"]')).toBeVisible();
  });
});
