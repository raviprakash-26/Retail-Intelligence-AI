import { expect, test, type Page } from "@playwright/test";
import { INVOICE_PARTICULARS } from "@/lib/documents/tax-invoice";
import { fill, STATE } from "./support";

/**
 * The document a customer takes away.
 *
 * A registered supplier is required to issue a tax invoice carrying prescribed
 * particulars. This product prepared GST returns out of its invoices for a long
 * time while giving a shop no way to hand one over; now that it does, the thing
 * worth protecting is that a layout change cannot quietly drop a particular. A
 * missing GSTIN is not something to learn about from a buyer's accountant.
 */

test.describe("issuing a tax invoice", () => {
  test.use({ storageState: STATE.owner });

  /**
   * Raises an invoice and opens its document.
   *
   * Its own sale rather than one from the seed: the demo tenant ships with
   * none, and depending on another spec file to have left one behind would
   * make this pass or fail on the alphabet.
   */
  async function openInvoice(page: Page) {
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
    await fill(page, 'input[name="lines.0.rate"]', "250");

    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/app\/sales\/[0-9a-f-]{8}/);
    await page.waitForLoadState("networkidle");

    await page.getByRole("link", { name: /tax invoice/i }).click();
    await page.waitForLoadState("networkidle");
  }

  test("carries every particular the rule asks for", async ({ page }) => {
    await openInvoice(page);

    await expect(
      page.getByText("Tax Invoice", { exact: false }).first(),
    ).toBeVisible();

    // Walked from the catalogue rather than listed here, so adding a
    // particular to the rule set is enough to have it checked.
    for (const particular of INVOICE_PARTICULARS) {
      const found = page.locator(`[data-particular="${particular.testId}"]`);
      await expect(
        found.first(),
        `${particular.key}: ${particular.requirement}`,
      ).toBeVisible();
    }
  });

  test("names the supplier with its GSTIN, not just the shop", async ({
    page,
  }) => {
    await openInvoice(page);

    const supplier = page.locator('[data-particular="supplier-block"]');
    await expect(supplier).toContainText("Ravi Retail Mart");
    // The particular that makes it a tax invoice rather than a receipt.
    await expect(supplier).toContainText("GSTIN");
  });

  test("says whether tax is payable on reverse charge", async ({ page }) => {
    // An invoice silent on it is incomplete, so the answer is printed even
    // when it is the ordinary one.
    await openInvoice(page);
    await expect(
      page.locator('[data-particular="reverse-charge"]'),
    ).toContainText(/Yes|No/);
  });

  test("writes the amount out in words as well as figures", async ({
    page,
  }) => {
    await openInvoice(page);
    await expect(
      page.locator('[data-particular="amount-in-words"]'),
    ).toContainText(/Rupees/);
  });

  test("leaves the application shell off the page when printed", async ({
    page,
  }) => {
    // What comes out of the printer is the document, not the navigation. The
    // back link and the print button are marked to be dropped.
    await openInvoice(page);
    await page.emulateMedia({ media: "print" });

    await expect(page.locator('[data-print="hide"]')).toBeHidden();
    await expect(
      page.locator('[data-particular="invoice-total"]'),
    ).toBeVisible();
  });
});

test.describe("sending the invoice to the customer", () => {
  test.use({ storageState: STATE.owner });

  test("offers the customer's own address and sends to it", async ({
    page,
  }) => {
    // The address is never typed. It comes off the customer record, which is
    // what keeps this from being a way to send mail from a trusted domain to
    // anybody at all — so the button names where it is going.
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

    await fill(page, 'input[name="lines.0.quantity"]', "2");
    await fill(page, 'input[name="lines.0.rate"]', "180");
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/app\/sales\/[0-9a-f-]{8}/);
    await page.waitForLoadState("networkidle");

    await page.getByRole("link", { name: /tax invoice/i }).click();
    await page.waitForLoadState("networkidle");

    const send = page.getByRole("button", { name: /email to/i });
    await expect(send).toBeVisible();
    await expect(send).toContainText("accounts@sharmaprovision.demo");

    await send.click();
    await expect(page.getByText(/sent to/i)).toBeVisible({ timeout: 20_000 });
  });

  test("says why, where a customer has no address on record", async ({
    page,
  }) => {
    // A control that looks available and quietly does nothing is worse than
    // one that explains itself.
    await page.goto("/app/sales/new");
    await page.waitForSelector('button:has-text("Choose a product")');

    const selects = page.locator('button[role="combobox"]');
    await selects.first().click();
    await page.locator('[role="option"]:has-text("Lakshmi Kirana")').click();
    await selects.nth(1).click();
    await page.locator('[role="option"]:has-text("Cash")').first().click();

    await page.locator('button:has-text("Choose a product")').first().click();
    await page.locator('input[placeholder*="Search by name"]').fill("Sugar");
    await page.waitForTimeout(1200);
    await page.locator("[cmdk-item]").first().click();

    await fill(page, 'input[name="lines.0.quantity"]', "1");
    await fill(page, 'input[name="lines.0.rate"]', "180");
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/app\/sales\/[0-9a-f-]{8}/);
    await page.waitForLoadState("networkidle");

    await page.getByRole("link", { name: /tax invoice/i }).click();
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByText(/add an email address to this customer/i),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /email to/i })).toHaveCount(
      0,
    );
  });
});
