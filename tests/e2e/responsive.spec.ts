import { test } from "@playwright/test";
import { STATE, expectNoHorizontalOverflow } from "./support";

test.use({ storageState: STATE.owner });

/**
 * Nothing scrolls sideways on a phone.
 *
 * Most of the people this is built for will use it on a phone, standing behind
 * a counter. A table that pushes the page 40 pixels wide is not a cosmetic
 * problem there — it is a figure they cannot read without pinching, on a screen
 * they are holding in one hand.
 *
 * Wide content is allowed to scroll inside its own container. The page must not.
 */

const PAGES = [
  "/",
  "/pricing",
  "/login",
  "/app",
  "/app/sales",
  "/app/accounting/trial-balance",
  "/app/accounting/statements",
  "/app/inventory",
  "/app/gst",
  "/app/tax",
  "/app/analytics",
  "/app/forecasting",
  "/app/ai/advisor",
  "/app/settings/billing",
] as const;

test.describe("on a phone", () => {
  test("no page scrolls sideways", async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path);
      await page.waitForLoadState("domcontentloaded");
      await expectNoHorizontalOverflow(page);
    }
  });
});
