import { describe, expect, it } from "vitest";
import {
  NAV_SECTIONS,
  QUICK_ACTIONS,
  activeHref,
  isIncludedInPlan,
  isPermitted,
  visibleQuickActions,
  visibleSections,
} from "@/lib/navigation";
import {
  ALL_PERMISSION_KEYS,
  SYSTEM_ROLE_TEMPLATES,
  permissionsForRole,
  type PermissionKey,
} from "@/lib/rbac/permissions";
import { PLAN_DEFINITIONS } from "@/lib/billing/plans";

const ALL_FEATURES = new Set(PLAN_DEFINITIONS.flatMap((plan) => plan.features));

function visibilityFor(roleKey: string, features = ALL_FEATURES) {
  const template = SYSTEM_ROLE_TEMPLATES.find((entry) => entry.key === roleKey);
  if (!template) throw new Error(`Unknown role ${roleKey}`);
  return {
    permissions: new Set<string>(permissionsForRole(template)),
    features: new Set<string>(features),
  };
}

describe("navigation config integrity", () => {
  it("references only permissions that exist", () => {
    const known = new Set<string>(ALL_PERMISSION_KEYS);
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        if (item.permission) {
          expect(known.has(item.permission), `${item.label} → ${item.permission}`).toBe(
            true,
          );
        }
      }
    }
    for (const action of QUICK_ACTIONS) {
      expect(known.has(action.permission), `${action.label}`).toBe(true);
    }
  });

  it("references only features some plan grants", () => {
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        if (item.feature) {
          expect(ALL_FEATURES.has(item.feature), `${item.label} → ${item.feature}`).toBe(
            true,
          );
        }
      }
    }
  });

  it("has unique hrefs", () => {
    const hrefs = NAV_SECTIONS.flatMap((section) =>
      section.items.map((item) => item.href),
    );
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("gives every planned item a build phase", () => {
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        if (item.status === "planned") {
          expect(item.phase, `${item.label} has no phase`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps every href under /app", () => {
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        expect(item.href.startsWith("/app"), item.href).toBe(true);
      }
    }
  });

  it("only points quick actions at pages that can exist", () => {
    // A quick action has to land somewhere real. A built module may have
    // sub-routes — /app/sales/new — but an unbuilt one must land on its own
    // placeholder page, or the New menu is a list of 404s. Nothing in the type
    // system catches this, because every href is cast to a Route at the call
    // site.
    const items = NAV_SECTIONS.flatMap((section) => section.items);

    for (const action of QUICK_ACTIONS) {
      const owner = items.find(
        (item) =>
          item.href === action.href ||
          action.href.startsWith(`${item.href}/`),
      );

      expect(owner, `${action.label} → ${action.href} reaches no module`).toBeDefined();

      if (owner && owner.href !== action.href) {
        expect(
          owner.status,
          `${action.label} links inside ${owner.href}, which is not built yet`,
        ).toBe("ready");
      }
    }
  });

  it("gives a built item no build phase", () => {
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        if (item.status === "ready") {
          expect(item.phase, `${item.label} is built but claims a phase`)
            .toBeUndefined();
        }
      }
    }
  });

  it("marks at most four items as mobile primary", () => {
    // The bottom bar has four slots plus a centre action button.
    const primary = NAV_SECTIONS.flatMap((section) =>
      section.items.filter((item) => item.primary),
    );
    expect(primary.length).toBeLessThanOrEqual(4);
  });
});

describe("permission gating", () => {
  it("shows an owner everything", () => {
    const sections = visibleSections(visibilityFor("owner"));
    const shown = sections.flatMap((section) => section.items).length;
    const total = NAV_SECTIONS.flatMap((section) => section.items).length;
    expect(shown).toBe(total);
  });

  it("hides accounting and settings from a cashier", () => {
    const sections = visibleSections(visibilityFor("cashier"));
    const labels = sections.flatMap((section) =>
      section.items.map((item) => item.label),
    );

    expect(labels).toContain("Dashboard");
    expect(labels).toContain("Sales");
    // A cashier holds none of these permissions, so the doors are not shown.
    expect(labels).not.toContain("Accounting");
    expect(labels).not.toContain("Settings");
    expect(labels).not.toContain("Reports");
    expect(labels).not.toContain("Analytics");
  });

  it("gives an auditor read access without any create action", () => {
    const visibility = visibilityFor("auditor");
    const labels = visibleSections(visibility).flatMap((section) =>
      section.items.map((item) => item.label),
    );

    expect(labels).toContain("Accounting");
    expect(labels).toContain("Reports");
    expect(labels).toContain("AI Auditor");

    // Read-only by construction: nothing that records a transaction.
    expect(visibleQuickActions(visibility)).toHaveLength(0);
  });

  it("drops a section once all of its items are hidden", () => {
    const sections = visibleSections({
      permissions: new Set<string>(["dashboard.view"]),
      features: ALL_FEATURES,
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]?.label).toBe("Overview");
  });

  it("returns nothing for a member with no permissions", () => {
    const sections = visibleSections({
      permissions: new Set<string>(),
      features: ALL_FEATURES,
    });
    expect(sections).toHaveLength(0);
  });

  it("filters quick actions by permission", () => {
    const cashier = visibleQuickActions(visibilityFor("cashier"));
    const labels = cashier.map((action) => action.label);

    expect(labels).toContain("New sale");
    expect(labels).toContain("Record receipt");
    // A cashier cannot raise a purchase or add a product.
    expect(labels).not.toContain("New purchase");
    expect(labels).not.toContain("Add product");
  });
});

describe("plan gating", () => {
  it("treats an item with no feature as always included", () => {
    const visibility = { permissions: new Set<string>(), features: new Set<string>() };
    expect(isIncludedInPlan({ feature: undefined }, visibility)).toBe(true);
  });

  it("reports a feature the plan lacks", () => {
    const starter = PLAN_DEFINITIONS.find((plan) => plan.key === "starter");
    const visibility = {
      permissions: new Set<string>(ALL_PERMISSION_KEYS),
      features: new Set<string>(starter?.features ?? []),
    };

    const inventory = NAV_SECTIONS.flatMap((section) => section.items).find(
      (item) => item.label === "Inventory",
    );
    expect(inventory).toBeDefined();
    expect(isIncludedInPlan(inventory!, visibility)).toBe(false);

    // Still permitted by role — the plan is a separate gate, and a plan-gated
    // item stays visible so the upgrade is discoverable.
    expect(isPermitted(inventory!, visibility)).toBe(true);
  });

  it("includes every gated navigation feature in the Business plan", () => {
    const business = PLAN_DEFINITIONS.find((plan) => plan.key === "business");
    const included = new Set<string>(business?.features ?? []);

    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        if (item.feature) {
          expect(included.has(item.feature), `${item.label}`).toBe(true);
        }
      }
    }
  });
});

describe("activeHref", () => {
  const targets = [
    { href: "/app", exact: true },
    { href: "/app/sales" },
    { href: "/app/settings/business" },
    { href: "/app/accounting" },
  ];

  it("matches an exact path", () => {
    expect(activeHref("/app/sales", targets)).toBe("/app/sales");
  });

  it("matches a nested path to its parent item", () => {
    expect(activeHref("/app/sales/new", targets)).toBe("/app/sales");
    expect(activeHref("/app/accounting/ledger", targets)).toBe("/app/accounting");
  });

  it("prefers the longest match", () => {
    expect(activeHref("/app/settings/business", targets)).toBe(
      "/app/settings/business",
    );
  });

  it("keeps the dashboard active only at its own path", () => {
    expect(activeHref("/app", targets)).toBe("/app");
    // The bug this guards: on a page with no bottom-bar tab of its own, the
    // dashboard used to claim it by prefix and light up while you were
    // somewhere else entirely.
    expect(activeHref("/app/products", targets)).toBeNull();
  });

  it("does not match a path that merely shares a prefix string", () => {
    // "/app/salesperson" is not inside "/app/sales".
    expect(activeHref("/app/salesperson", targets)).toBeNull();
  });

  it("still lets a non-exact parent claim its descendants", () => {
    expect(activeHref("/app/sales/new/line", targets)).toBe("/app/sales");
  });

  it("returns null when nothing matches", () => {
    expect(activeHref("/marketing", [{ href: "/app/sales" }])).toBeNull();
  });

  it("marks the dashboard exact in the real navigation", () => {
    const dashboard = NAV_SECTIONS.flatMap((section) => section.items).find(
      (item) => item.href === "/app",
    );
    expect(dashboard?.exact).toBe(true);
  });
});

describe("role coverage", () => {
  it("gives every role at least the dashboard", () => {
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      const sections = visibleSections({
        permissions: new Set<string>(permissionsForRole(template)),
        features: ALL_FEATURES,
      });
      const labels = sections.flatMap((section) =>
        section.items.map((item) => item.label),
      );
      expect(labels, `${template.key} sees nothing`).toContain("Dashboard");
    }
  });

  it("never shows an item whose permission the role lacks", () => {
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      const granted = new Set<string>(permissionsForRole(template));
      const sections = visibleSections({
        permissions: granted,
        features: ALL_FEATURES,
      });

      for (const section of sections) {
        for (const item of section.items) {
          if (item.permission) {
            expect(
              granted.has(item.permission as PermissionKey),
              `${template.key} shown ${item.label}`,
            ).toBe(true);
          }
        }
      }
    }
  });
});
