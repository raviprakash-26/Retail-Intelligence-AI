import { expect, test, type Page } from "@playwright/test";
import { STATE } from "./support";

test.use({ storageState: STATE.owner });

/**
 * The claims the product refuses to make.
 *
 * Every one of these is a sentence somebody could quietly delete to make a page
 * read better, and every one of them is load-bearing: they are the difference
 * between preparing a return and claiming to have filed one, between an
 * observation and an accusation, between an estimate and a promise.
 *
 * The unit tests protect the vocabulary in the catalogues. These protect what a
 * person actually sees.
 */

const PROMISES = [
  "guaranteed",
  "will increase",
  "will improve",
  "risk-free",
  "no risk",
  "certain to",
];

const ACCUSATIONS = [
  "fraud",
  "fraudulent",
  "theft",
  "stolen",
  "embezzl",
  "criminal",
  "dishonest",
];

/**
 * A module's text, whichever state its plan leaves it in.
 *
 * A page the subscription does not include renders an explanation under an
 * `h2` rather than the module under an `h1`, so waiting for `h1` alone times
 * out on exactly the pages whose wording matters most.
 */
async function readModule(page: Page, path: string): Promise<string> {
  await page.goto(path);
  // Waiting for a heading is not enough: the shell has its own, so the wait
  // resolves against chrome that was already there and the module's text is
  // read before it arrives. Waiting for the network to settle waits for the
  // thing actually being asserted about.
  await page.waitForLoadState("networkidle");
  return (await page.locator("body").innerText()).toLowerCase();
}

test.describe("what the pages promise", () => {
  test("GST is prepared, never filed", async ({ page }) => {
    const text = await readModule(page, "/app/gst");
    expect(text).toMatch(/cannot (file|submit)|not.*filed|prepar/);
    expect(text).not.toMatch(/return has been filed|successfully filed/);
  });

  test("income tax is estimated, never advised", async ({ page }) => {
    const text = await readModule(page, "/app/tax");
    expect(text).toMatch(/estimate|preparation|not.*advice/);
  });

  test("the health indicator is not a credit score", async ({ page }) => {
    const text = await readModule(page, "/app/analytics");
    if (text.includes("out of 100")) {
      expect(text).toMatch(/not a credit score/);
    }
  });

  test("the auditor accuses nobody", async ({ page }) => {
    const text = await readModule(page, "/app/ai/auditor");

    // Whichever state the demo tenant's plan puts this page in, it may not
    // accuse anybody — a locked page has no excuse to either.
    const found = ACCUSATIONS.filter((word) => text.includes(word));
    expect(found, `the auditor page says ${found.join(", ")}`).toEqual([]);

    if (!text.includes("not in your plan")) {
      expect(text).toContain("not in a position to know");
    }
  });

  test("the advisor promises nothing", async ({ page }) => {
    const text = await readModule(page, "/app/ai/advisor");

    const found = PROMISES.filter((word) => text.includes(word));
    expect(found, `the advisor page says ${found.join(", ")}`).toEqual([]);

    if (!text.includes("not in your plan")) {
      expect(text).toContain("right to ignore");
    }
  });

  test("forecasts lead with a range", async ({ page }) => {
    const text = await readModule(page, "/app/forecasting");
    // Either a band, or an honest refusal to draw one. Never a bare number
    // presented as what will happen.
    expect(text).toMatch(/between|to |range|not enough|too (short|uneven)/);
  });

  test("says whether a payment can be taken, and offers no button when it cannot", async ({
    page,
  }) => {
    // Razorpay is integrated, but this installation has no credentials — which
    // is the state most installations will be in. The page has to say that
    // plainly rather than showing a button that resolves against nothing.
    const text = await readModule(page, "/app/settings/billing");
    expect(text).toMatch(
      /no payment provider is connected|cannot take a payment|keys are missing/i,
    );
    await expect(
      page.getByRole("button", { name: /^Pay and move to/ }),
    ).toHaveCount(0);
    // And the promise that matters most on that page.
    expect(text).toContain("unreadable");
  });

  test("the payment webhook is not a page, and answers nothing useful unconfigured", async ({
    page,
  }) => {
    // The one publicly reachable endpoint that could change what a business has
    // paid for. With no secret configured it must not exist at all — an
    // endpoint that accepted unsigned bodies would be worse than no endpoint.
    const posted = await page.request.post("/api/webhooks/razorpay", {
      data: { event: "payment.captured" },
    });
    expect(posted.status()).toBe(404);
    expect(await posted.text()).not.toMatch(/stack|prisma|secret/i);

    const fetched = await page.request.get("/api/webhooks/razorpay");
    expect(fetched.status()).toBe(404);
  });
});
