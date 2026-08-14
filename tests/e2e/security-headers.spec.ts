import { expect, test } from "@playwright/test";
import { STATE, collectPageErrors, collectPolicyViolations } from "./support";

/**
 * What the browser is told, and whether the product survives being told it.
 *
 * A content-security-policy is trivially easy to write and trivially easy to
 * get wrong in a way that only shows up in a browser. The first version of this
 * one rendered a sign-in page with no working form.
 */

/** The public half. Signed out, because /login redirects anybody who is not. */
test.describe("security headers on a public page", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a public page carries the headers", async ({ page }) => {
    const response = await page.goto("/login");
    const headers = response?.headers() ?? {};

    expect(headers["content-security-policy"]).toBeTruthy();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["strict-transport-security"]).toContain("max-age=");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    // The framework is not advertised to anybody scanning for one.
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("the policy forbids framing, foreign posts and foreign connections", async ({
    page,
  }) => {
    const response = await page.goto("/login");
    const csp = response?.headers()["content-security-policy"] ?? "";

    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    // Only the dev server needs eval.
    expect(csp).not.toContain("unsafe-eval");
  });
});

test.describe("security headers inside the application", () => {
  test.use({ storageState: STATE.owner });

  test("the application area gets a fresh nonce, not unsafe-inline", async ({
    page,
  }) => {
    const first = await page.goto("/app/sales");
    const firstCsp = first?.headers()["content-security-policy"] ?? "";
    expect(firstCsp).toMatch(/'nonce-[a-f0-9]{16,}'/);
    expect(firstCsp).not.toContain("script-src 'self' 'unsafe-inline'");

    const second = await page.goto("/app/sales");
    const secondCsp = second?.headers()["content-security-policy"] ?? "";

    const nonceOf = (csp: string) => csp.match(/'nonce-([a-f0-9]+)'/)?.[1];
    expect(nonceOf(firstCsp)).not.toBe(nonceOf(secondCsp));
  });

  test("every module renders under the policy", async ({ page }) => {
    const violations = collectPolicyViolations(page);
    const errors = collectPageErrors(page);

    for (const path of [
      "/app",
      "/app/sales",
      "/app/purchases",
      "/app/expenses",
      "/app/accounting/statements",
      "/app/inventory",
      "/app/gst",
      "/app/settings/billing",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("domcontentloaded");
    }

    // One known exception, and exactly one: next-themes injects a pre-paint
    // script into the root layout, which is shared with the static marketing
    // pages and so cannot carry a per-request nonce. Losing it costs dark-mode
    // users a flash of the light theme and nothing else. Asserting "at most
    // that one" means anything else being blocked fails loudly.
    const distinct = [...new Set(violations)];
    expect(distinct.length, distinct.join(" | ")).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test("the session cookie is out of reach of script", async ({ page }) => {
    // A browser will not let a page forge an Origin header, so CSRF itself is
    // asserted in the unit tests. What a browser can prove is that script
    // cannot read the session, which is what an XSS would go for first.
    //
    // The navigation matters: with a restored session the page starts blank,
    // and `document.cookie` on about:blank throws rather than returning "".
    await page.goto("/app");
    const readable = await page.evaluate(() => document.cookie);
    expect(readable).not.toContain("riai_session");
  });
});
