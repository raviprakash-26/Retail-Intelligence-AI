import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV_SECTIONS } from "@/lib/navigation";

/**
 * Every gated module actually asks.
 *
 * The navigation marks what a plan does not include, and that marking is the
 * only thing most people ever see — which is exactly why it cannot be the only
 * thing standing between a Starter customer and the auditor. Anybody can type a
 * URL.
 *
 * This reads the page sources rather than rendering them. It cannot prove the
 * gate returns the right thing; what it can do is fail loudly the day somebody
 * adds a feature-gated item to the navigation and forgets the check, which is
 * the mistake actually worth catching. The behaviour itself is covered by the
 * integration tests against the entitlement service.
 */

const ROOT = process.cwd();

function pageSourceFor(href: string): string {
  const relative = href.replace(/^\/app\/?/, "");
  const path = join(ROOT, "src/app/(app)/app", relative, "page.tsx");
  return readFileSync(path, "utf8");
}

const gatedItems = NAV_SECTIONS.flatMap((section) => section.items).filter(
  (item) => item.feature !== undefined && item.status === "ready",
);

describe("feature-gated pages", () => {
  it("there are some, so this test is not passing vacuously", () => {
    expect(gatedItems.length).toBeGreaterThan(5);
  });

  for (const item of gatedItems) {
    it(`${item.label} checks its own entitlement`, () => {
      const source = pageSourceFor(item.href);
      expect(source, `${item.href} does not call featureGate`).toContain(
        "featureGate(",
      );
      // And checks the same feature the navigation gates it on, rather than
      // some other one that happens to be included.
      const featureName = Object.entries(FEATURE_BY_VALUE).find(
        ([value]) => value === item.feature,
      )?.[1];
      expect(featureName, `no constant name for ${item.feature}`).toBeTruthy();
      expect(source).toContain(`FEATURE.${featureName}`);
    });
  }
});

/** Value → constant name, so the assertion can name what it expects to see. */
const FEATURE_BY_VALUE: Record<string, string> = {
  "core.transactions": "CORE_TRANSACTIONS",
  "accounting.basic": "ACCOUNTING_BASIC",
  "accounting.statements": "ACCOUNTING_STATEMENTS",
  inventory: "INVENTORY",
  "gst.preparation": "GST_PREPARATION",
  "tax.preparation": "TAX_PREPARATION",
  analytics: "ANALYTICS",
  "ai.accountant": "AI_ACCOUNTANT",
  "ai.auditor": "AI_AUDITOR",
  "ai.advisor": "AI_ADVISOR",
  forecasting: "FORECASTING",
  "multi.branch": "MULTI_BRANCH",
  "permissions.advanced": "ADVANCED_PERMISSIONS",
  "support.priority": "PRIORITY_SUPPORT",
  "reports.export": "EXPORTS",
};
