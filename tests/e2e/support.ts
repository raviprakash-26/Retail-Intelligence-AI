import { expect, type Page } from "@playwright/test";

/**
 * The few things every end-to-end spec needs.
 *
 * Credentials come from the seed and are development-only; they are written
 * down in the README beside the demo tenant they belong to.
 */

export const DEMO = {
  owner: "owner@raviretailmart.demo",
  accountant: "accountant@raviretailmart.demo",
  cashier: "cashier@raviretailmart.demo",
  password: "DemoRetail@2026",
} as const;

export const ADMIN = {
  email: "admin@retailintelligence.local",
  password: "AdminRetail@2026",
} as const;

/**
 * Where each role's signed-in session is kept between specs.
 *
 * Written by the setup project, read by everything else. It lives here rather
 * than beside the setup because Playwright refuses to let one test file import
 * another, and a shared constant in a support module is what that rule is
 * pointing at.
 */
export const STATE = {
  owner: "test-results/.auth/owner.json",
  cashier: "test-results/.auth/cashier.json",
  admin: "test-results/.auth/admin.json",
} as const;

/**
 * Fills a field and checks it took.
 *
 * React-controlled inputs occasionally drop a programmatic fill when hydration
 * lands mid-keystroke, and a test that silently submits an empty form fails
 * later with a message about something else entirely.
 */
export async function fill(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  const field = page.locator(selector).first();
  await field.waitFor({ state: "visible" });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await field.fill(value);
    if ((await field.inputValue()) === value) return;
    await page.waitForTimeout(200);
  }

  throw new Error(`Could not set ${selector} to "${value}"`);
}

export async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await fill(page, 'input[name="email"]', email);
  await fill(page, 'input[name="password"]', password);
  await page.click('button[type="submit"]');
  // Wait for the sign-in to land somewhere. Returning as soon as the button is
  // clicked lets the next navigation race the session cookie, which fails as a
  // timeout on a selector three lines later and reads like a broken page.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

export async function signInAsOwner(page: Page): Promise<void> {
  await signIn(page, DEMO.owner, DEMO.password);
  await page.waitForURL("**/app");
}

/** Every content-security-policy violation the browser reported. */
export function collectPolicyViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(text)) {
      // The nonce and the offending hash are inside the message, so identical
      // violations look distinct until both are normalised away.
      violations.push(
        text
          .replace(/'nonce-[a-f0-9]+'/g, "'nonce-X'")
          .replace(/'sha256-[^']+'/g, "'sha256-X'"),
      );
    }
  });
  return violations;
}

/** Uncaught errors from the page, which no spec should ever produce. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

/**
 * Nothing in the product may scroll the page sideways on a phone.
 *
 * Measured by trying to scroll rather than by comparing widths. Chrome inflates
 * `documentElement.scrollWidth` with the content of descendant scrollers, so a
 * comparison reports overflow for a wide table that is correctly scrolling
 * inside its own container — which is the arrangement the rule is meant to
 * encourage. Asking the page to move and seeing whether it does is the thing a
 * person actually experiences, and it cannot be fooled either way.
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const moved = await page.evaluate(() => {
    const before = window.scrollX;
    window.scrollTo(99_999, window.scrollY);
    const after = window.scrollX;
    window.scrollTo(before, window.scrollY);
    return after - before;
  });

  expect(moved, `the page panned ${moved}px sideways`).toBe(0);
}
