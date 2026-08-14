import { describe, expect, it } from "vitest";
import {
  REPORTS,
  REPORT_CATEGORIES,
  findReport,
  isReportKey,
  visibleReports,
  type ReportDefinition,
} from "@/lib/reports/catalogue";
import {
  ALL_PERMISSION_KEYS,
  SYSTEM_ROLE_TEMPLATES,
  permissionsForRole,
} from "@/lib/rbac/permissions";
import { PLAN_DEFINITIONS } from "@/lib/billing/plans";

const ALL_FEATURES = new Set(PLAN_DEFINITIONS.flatMap((plan) => plan.features));

/**
 * The catalogue widened to its declared type.
 *
 * `REPORTS` is `as const`, so an entry with no `feature` has no such property
 * in its literal type and the union cannot be asked about it. The declaration
 * is what the code is checked against, so that is what the test iterates.
 */
const ALL: readonly ReportDefinition[] = REPORTS;

function permissionsFor(roleKey: string): Set<string> {
  const template = SYSTEM_ROLE_TEMPLATES.find((entry) => entry.key === roleKey);
  if (!template) throw new Error(`Unknown role ${roleKey}`);
  return new Set<string>(permissionsForRole(template));
}

describe("the catalogue is internally consistent", () => {
  it("has unique keys", () => {
    const keys = REPORTS.map((report) => report.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names only permissions that exist", () => {
    const known = new Set<string>(ALL_PERMISSION_KEYS);
    for (const report of ALL) {
      expect(known.has(report.permission), report.key).toBe(true);
    }
  });

  it("names only features some plan grants", () => {
    for (const report of ALL) {
      if (report.feature) {
        expect(ALL_FEATURES.has(report.feature), report.key).toBe(true);
      }
    }
  });

  it("puts every report in a category the hub renders", () => {
    for (const report of ALL) {
      expect(REPORT_CATEGORIES).toContain(report.category);
    }
  });

  it("says where every report's figures come from", () => {
    // The whole claim of the module is that it reports what something else
    // computed. A report that cannot name its source is one nobody can check.
    for (const report of ALL) {
      expect(report.source.length, report.key).toBeGreaterThan(0);
      expect(report.description.length, report.key).toBeGreaterThan(20);
    }
  });

  it("resolves a key, and refuses one it does not know", () => {
    expect(findReport("trial-balance")?.title).toBe("Trial balance");
    expect(findReport("../../etc/passwd")).toBeUndefined();
    expect(isReportKey("trial-balance")).toBe(true);
    expect(isReportKey("made-up")).toBe(false);
  });
});

describe("who sees which report", () => {
  it("shows an owner every one", () => {
    const shown = visibleReports(permissionsFor("owner")).flatMap(
      (group) => group.reports,
    );
    expect(shown).toHaveLength(REPORTS.length);
  });

  it("shows a cashier none, because a cashier has no reports permission", () => {
    expect(visibleReports(permissionsFor("cashier"))).toHaveLength(0);
  });

  it("does not let the reports permission stand in for the module's own", () => {
    // The reports permission opens the cabinet, not every drawer in it.
    // Somebody who may read reports but not purchases must not reach the
    // purchase register by asking for it as a report.
    const shown = visibleReports(
      new Set(["reports.view", "accounting.view"]),
    ).flatMap((group) => group.reports.map((report) => report.key));

    expect(shown).toContain("trial-balance");
    expect(shown).not.toContain("purchase-register");
    expect(shown).not.toContain("sales-register");
    expect(shown).not.toContain("gst-summary");
  });

  it("shows nothing at all without the reports permission", () => {
    // Even holding every module permission there is.
    const everything = new Set<string>(ALL_PERMISSION_KEYS);
    everything.delete("reports.view");
    expect(visibleReports(everything)).toHaveLength(0);
  });

  it("drops a category once none of its reports are visible", () => {
    const groups = visibleReports(new Set(["reports.view", "accounting.view"]));
    expect(groups.map((group) => group.category)).toEqual(["Accounting"]);
  });

  it("gives the tax consultant the compliance report and not the registers", () => {
    const shown = visibleReports(permissionsFor("tax_consultant")).flatMap(
      (group) => group.reports.map((report) => report.key),
    );
    expect(shown).toContain("gst-summary");
    expect(shown).toContain("trial-balance");
    // They may view sales, so the register is legitimately theirs to read.
    expect(shown).toContain("sales-register");
    // They hold no inventory permission.
    expect(shown).not.toContain("stock-on-hand");
  });
});
