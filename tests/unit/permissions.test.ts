import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_KEYS,
  PERMISSIONS,
  SYSTEM_ROLE,
  SYSTEM_ROLE_TEMPLATES,
  getRoleTemplate,
  permissionsForRole,
  type PermissionKey,
} from "@/lib/rbac/permissions";
import {
  PERMISSION_FEATURE_REQUIREMENTS,
  PLAN_DEFINITIONS,
} from "@/lib/billing/plans";

const permissionsOf = (key: string): readonly PermissionKey[] => {
  const template = getRoleTemplate(key);
  if (!template) throw new Error(`Unknown role ${key}`);
  return permissionsForRole(template);
};

describe("permission catalogue", () => {
  it("uses dotted lowercase keys throughout", () => {
    for (const key of ALL_PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });

  it("gives every permission a module and a description", () => {
    for (const [key, meta] of Object.entries(PERMISSIONS)) {
      expect(meta.module, `${key} has no module`).toBeTruthy();
      expect(
        meta.description.length,
        `${key} has no description`,
      ).toBeGreaterThan(5);
    }
  });

  it("has no duplicate keys", () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length);
  });
});

describe("system role templates", () => {
  it("defines all six documented roles", () => {
    const keys = SYSTEM_ROLE_TEMPLATES.map((template) => template.key).sort();
    expect(keys).toEqual(
      [
        SYSTEM_ROLE.ACCOUNTANT,
        SYSTEM_ROLE.AUDITOR,
        SYSTEM_ROLE.CASHIER,
        SYSTEM_ROLE.MANAGER,
        SYSTEM_ROLE.OWNER,
        SYSTEM_ROLE.TAX_CONSULTANT,
      ].sort(),
    );
  });

  it("references only permissions that exist", () => {
    const known = new Set<string>(ALL_PERMISSION_KEYS);
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      for (const key of template.permissions ?? []) {
        expect(known.has(key), `${template.key} grants unknown "${key}"`).toBe(
          true,
        );
      }
    }
  });

  it("grants the owner everything, including permissions added later", () => {
    expect(permissionsOf(SYSTEM_ROLE.OWNER)).toHaveLength(
      ALL_PERMISSION_KEYS.length,
    );
  });

  it("grants no role duplicate permissions", () => {
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      const granted = permissionsForRole(template);
      expect(new Set(granted).size, `${template.key} has duplicates`).toBe(
        granted.length,
      );
    }
  });
});

describe("least privilege", () => {
  it("keeps the auditor read-only", () => {
    const auditor = new Set<string>(permissionsOf(SYSTEM_ROLE.AUDITOR));

    // Every write permission the auditor must not hold.
    const forbidden = [
      "sales.create",
      "sales.void",
      "sales.return",
      "purchases.create",
      "purchases.void",
      "expenses.create",
      "expenses.void",
      "receipts.create",
      "payments.create",
      "customers.manage",
      "suppliers.manage",
      "products.manage",
      "inventory.adjust",
      "employees.manage",
      "payroll.manage",
      "accounting.journal.create",
      "accounting.journal.void",
      "accounting.accounts.manage",
      "accounting.period.close",
      "settings.manage",
      "users.manage",
      "roles.manage",
      "branches.manage",
      "billing.manage",
    ];

    for (const key of forbidden) {
      expect(auditor.has(key), `Auditor must not hold ${key}`).toBe(false);
    }

    // The title used to end "apart from resolving findings", and the line
    // here asserted `audit.resolve`. Nothing ever checked it: the auditor
    // makes observations rather than findings anybody triages, and the page
    // is gated on `ai.auditor`. What the role really holds is the ability to
    // run the rule set and read what it produced.
    expect(auditor.has("audit.run")).toBe(true);
    expect(auditor.has("ai.auditor")).toBe(true);
  });

  it("keeps the cashier to counter operations", () => {
    const cashier = new Set<string>(permissionsOf(SYSTEM_ROLE.CASHIER));

    expect(cashier.has("sales.create")).toBe(true);
    expect(cashier.has("receipts.create")).toBe(true);

    // A cashier must not be able to unwind their own mistakes silently, see
    // company-wide financials, or touch the ledger.
    for (const key of [
      "sales.void",
      "purchases.create",
      "accounting.view",
      "accounting.statements.view",
      "accounting.journal.create",
      "reports.view",
      "reports.export",
      "analytics.view",
      "settings.manage",
      "billing.view",
    ]) {
      expect(cashier.has(key), `Cashier must not hold ${key}`).toBe(false);
    }
  });

  it("does not let a manager void posted entries or change the chart of accounts", () => {
    const manager = new Set<string>(permissionsOf(SYSTEM_ROLE.MANAGER));

    for (const key of [
      "sales.void",
      "purchases.void",
      "expenses.void",
      "receipts.void",
      "payments.void",
      "accounting.journal.create",
      "accounting.journal.void",
      "accounting.accounts.manage",
      "accounting.period.close",
      "billing.manage",
      "roles.manage",
    ]) {
      expect(manager.has(key), `Manager must not hold ${key}`).toBe(false);
    }
  });

  it("restricts the tax consultant to compliance and read access", () => {
    const consultant = new Set<string>(
      permissionsOf(SYSTEM_ROLE.TAX_CONSULTANT),
    );

    // This asserted `gst.prepare` and `tax.prepare` and passed for as long as
    // they were in the template — which was the whole of the problem. Neither
    // was ever checked anywhere, so the test proved the catalogue said
    // something rather than that the product did it. Both modules are
    // read-only working papers with no actions at all, so the reachable thing
    // is the view permission, and that is what is asserted now.
    expect(consultant.has("gst.view")).toBe(true);
    expect(consultant.has("tax.view")).toBe(true);

    for (const key of [
      "sales.create",
      "purchases.create",
      "expenses.create",
      "accounting.journal.create",
      "users.manage",
      "billing.manage",
    ]) {
      expect(consultant.has(key), `Tax consultant must not hold ${key}`).toBe(
        false,
      );
    }
  });

  it("reserves billing management for the owner", () => {
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      if (template.key === SYSTEM_ROLE.OWNER) continue;
      const granted = new Set<string>(permissionsForRole(template));
      expect(
        granted.has("billing.manage"),
        `${template.key} must not manage billing`,
      ).toBe(false);
    }
  });

  it("gives only the accountant and owner the ability to close a period", () => {
    const holders = SYSTEM_ROLE_TEMPLATES.filter((template) =>
      new Set<string>(permissionsForRole(template)).has(
        "accounting.period.close",
      ),
    ).map((template) => template.key);

    expect(holders.sort()).toEqual(
      [SYSTEM_ROLE.ACCOUNTANT, SYSTEM_ROLE.OWNER].sort(),
    );
  });
});

describe("plan entitlement mapping", () => {
  it("maps only permissions that exist", () => {
    const known = new Set<string>(ALL_PERMISSION_KEYS);
    for (const key of Object.keys(PERMISSION_FEATURE_REQUIREMENTS)) {
      expect(known.has(key), `Unknown permission "${key}" in feature map`).toBe(
        true,
      );
    }
  });

  it("maps only features some plan actually grants", () => {
    const offered = new Set(PLAN_DEFINITIONS.flatMap((plan) => plan.features));
    for (const feature of Object.values(PERMISSION_FEATURE_REQUIREMENTS)) {
      expect(
        feature && offered.has(feature),
        `Feature "${feature}" is required by a permission but no plan offers it`,
      ).toBe(true);
    }
  });
});
