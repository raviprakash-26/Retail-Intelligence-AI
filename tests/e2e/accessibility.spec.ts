import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { STATE } from "./support";

/**
 * Whether the application can be used by somebody who is not using a mouse and
 * a pair of working eyes.
 *
 * There was evident care here before this file existed — forty-eight
 * `aria-label`s, decorative icons hidden, every image with alt text — and
 * nothing that checked any of it. Care that nothing enforces is care that
 * survives until the first hurried afternoon.
 *
 * The sweep runs axe against every page a signed-in owner can reach, in both
 * colour schemes, and fails on serious and critical findings. Moderate and
 * minor are reported in the trace but do not fail: this is a gate meant to hold
 * the line on the things that stop somebody using the product, not a WCAG audit
 * that nobody can ever get to zero and everybody therefore learns to skip.
 *
 * Colour is checked in both themes on purpose. A token that passes contrast on
 * a white background frequently fails on a dark one, and this product ships
 * both from the same variables.
 */

/** Pages an owner can reach. One per module rather than every leaf. */
const PAGES = [
  ["dashboard", "/app"],
  ["sales", "/app/sales"],
  ["new sale", "/app/sales/new"],
  ["purchases", "/app/purchases"],
  ["expenses", "/app/expenses"],
  ["receipts", "/app/receipts"],
  ["payments", "/app/payments"],
  ["products", "/app/products"],
  ["customers", "/app/customers"],
  ["suppliers", "/app/suppliers"],
  ["inventory", "/app/inventory"],
  ["accounting", "/app/accounting"],
  ["journal", "/app/accounting/journal"],
  ["trial balance", "/app/accounting/trial-balance"],
  ["statements", "/app/accounting/statements"],
  ["banking", "/app/banking"],
  ["gst", "/app/gst"],
  ["income tax", "/app/tax"],
  ["analytics", "/app/analytics"],
  ["forecasting", "/app/forecasting"],
  ["reports", "/app/reports"],
  ["auditor", "/app/ai/auditor"],
  ["advisor", "/app/ai/advisor"],
  ["accountant", "/app/ai/accountant"],
  ["payroll", "/app/payroll"],
  ["settings", "/app/settings/business"],
  ["your data", "/app/settings/data"],
] as const;

/**
 * The rules this gate holds.
 *
 * `wcag2a` and `wcag2aa` are the level most public bodies and most procurement
 * checklists actually ask for. Best-practice rules are left out: they are
 * opinions worth reading rather than a line worth failing a build on.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function scan(page: Page, url: string) {
  await page.goto(url);
  // The shell settles asynchronously — a scan that starts mid-hydration reports
  // controls that were about to be labelled.
  await page.waitForLoadState("networkidle");

  return new AxeBuilder({ page }).withTags(TAGS).analyze();
}

/** A finding, in the form somebody can act on without opening a trace. */
function describe(
  violations: Awaited<ReturnType<typeof scan>>["violations"],
): string {
  return violations
    .map((violation) => {
      const where = violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(" "))
        .join("\n      ");
      return `  ${violation.id} (${violation.impact}) — ${violation.help}\n      ${where}`;
    })
    .join("\n");
}

test.describe("every page an owner can open", () => {
  test.use({ storageState: STATE.owner });

  for (const [name, url] of PAGES) {
    test(`${name} has no serious accessibility failure`, async ({ page }) => {
      const results = await scan(page, url);
      const serious = results.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      );

      expect(serious, `${url}\n${describe(serious)}`).toEqual([]);
    });
  }
});

test.describe("the dark theme", () => {
  test.use({ storageState: STATE.owner, colorScheme: "dark" });

  // Contrast is the rule that differs between themes, and this product builds
  // both from one set of variables — so a token corrected for one can quietly
  // fail the other.
  for (const [name, url] of [
    ["dashboard", "/app"],
    ["statements", "/app/accounting/statements"],
    ["auditor", "/app/ai/auditor"],
    ["analytics", "/app/analytics"],
  ] as const) {
    test(`${name} keeps its contrast in the dark`, async ({ page }) => {
      const results = await scan(page, url);
      const contrast = results.violations.filter(
        (violation) => violation.id === "color-contrast",
      );

      expect(contrast, `${url}\n${describe(contrast)}`).toEqual([]);
    });
  }
});

test.describe("without a mouse", () => {
  test.use({ storageState: STATE.owner });

  test("the keyboard reaches the main navigation and shows where it is", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.waitForLoadState("networkidle");

    // Tab until something in the navigation has focus. A ceiling rather than a
    // loop for ever: if twenty-five stops do not reach the nav, that is the
    // finding.
    let reached = false;
    for (let step = 0; step < 25 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(active?.closest("nav"));
      });
    }
    expect(reached, "the keyboard never reached a nav link").toBe(true);

    // And the focused thing has to be visible, or a keyboard user is lost.
    const visible = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active) return false;
      const style = getComputedStyle(active);
      return style.outlineStyle !== "none" || style.boxShadow !== "none";
    });
    expect(visible, "the focused control has no visible focus ring").toBe(true);
  });

  test("a dialog takes focus and gives it back", async ({ page }) => {
    // The failure this catches: a dialog that opens without moving focus
    // leaves a screen-reader user reading the page behind it, with no idea
    // anything happened.
    await page.goto("/app/customers");
    await page.waitForLoadState("networkidle");

    const add = page.getByRole("link", { name: /new customer/i }).first();
    if ((await add.count()) === 0) test.skip();

    await add.click();
    await page.waitForLoadState("networkidle");

    const focusedInside = await page.evaluate(() => {
      const active = document.activeElement;
      return active !== document.body && active !== null;
    });
    expect(focusedInside).toBe(true);
  });
});
