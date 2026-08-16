import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_KEYS,
  PERMISSIONS,
  SYSTEM_ROLE_TEMPLATES,
  type PermissionKey,
} from "@/lib/rbac/permissions";

/**
 * Every permission the catalogue offers reaches an authorization check.
 *
 * Eight did not. `sales.edit`, `purchases.edit` and `expenses.edit` described
 * drafts the product does not keep; `gst.settings` a tax configuration screen
 * that does not exist; `audit.view` and `audit.resolve` an audit workflow the
 * auditor deliberately does not have; `gst.prepare` and `tax.prepare` a
 * preparing-versus-viewing split in two modules that have no actions at all.
 *
 * Granting one did nothing. Withholding one protected nothing, which is the
 * half that mattered — the Accountant and Tax Consultant roles carried
 * `gst.prepare` precisely to separate who may prepare a return from who may
 * only read one, and that separation was fiction.
 *
 * All eight were harmless while the catalogue was invisible. Custom roles put
 * it on a screen, each description beside a checkbox, so they became a list of
 * capabilities offered to a paying customer and not delivered — the same
 * defect as a pricing page selling a feature that does not exist, one screen
 * further in.
 *
 * This reads the source rather than exercising the guards. The integration
 * tests prove a guard refuses; this proves nobody forgot to write one.
 */

/**
 * Permissions that guard nothing by themselves, and why.
 *
 * Empty, and that is the point — it exists so that the next one has somewhere
 * to be argued for in writing rather than being silently absent from every
 * guard. An omission and a decision look identical in a codebase, and only one
 * of them should pass.
 */
const NO_CHECK_NEEDED: Partial<Record<PermissionKey, string>> = {};

function sourceFiles(): string[] {
  return globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() }).filter(
    (file) => !file.endsWith("lib/rbac/permissions.ts"),
  );
}

/**
 * The guards, by name.
 *
 * Written out rather than matched loosely, because "the string appears in a
 * file somewhere" is what let the first version of the plan-claims test count
 * a marketing page as a gate.
 */
const GUARD =
  /(assertPermission|requirePermission|hasPermission|hasAnyPermission|hasAllPermissions|permissions\.has)\(\s*\[?\s*((?:"[a-z_.]+"|,|\s)+)/g;

/**
 * Places that check a permission read from a table rather than written out.
 *
 * The report catalogue carries a `permission` on each entry and
 * `reports/access.ts` refuses on it; navigation and the onboarding checklist
 * do the same to decide what to draw. A key used only that way is enforced —
 * it just cannot be seen by looking for its own name next to a guard, and a
 * test that ignored this would demand a literal call that would be wrong to
 * write.
 */
const BY_TABLE: ReadonlyArray<{ file: string; field: RegExp }> = [
  { file: "src/lib/reports/catalogue.ts", field: /permission: "([a-z_.]+)"/g },
  { file: "src/lib/navigation.ts", field: /permission: "([a-z_.]+)"/g },
  {
    file: "src/server/company/onboarding-service.ts",
    field: /requires: "([a-z_.]+)"/g,
  },
];

function checkedKeys(): { direct: Set<string>; byTable: Set<string> } {
  const direct = new Set<string>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(GUARD)) {
      for (const quoted of match[2]!.matchAll(/"([a-z_.]+)"/g)) {
        direct.add(quoted[1]!);
      }
    }
  }

  const byTable = new Set<string>();
  for (const entry of BY_TABLE) {
    const text = readFileSync(entry.file, "utf8");
    for (const match of text.matchAll(entry.field)) byTable.add(match[1]!);
  }

  return { direct, byTable };
}

describe("every permission the catalogue offers", () => {
  const { direct, byTable } = checkedKeys();

  it("is checked somewhere, or says why it needs no check", () => {
    const unchecked = ALL_PERMISSION_KEYS.filter(
      (key) => !NO_CHECK_NEEDED[key] && !direct.has(key) && !byTable.has(key),
    );

    expect(
      unchecked,
      `offered on the roles screen and checked nowhere: ${unchecked.join(", ")}`,
    ).toEqual([]);
  });

  it("guards a page or an action, not only what is drawn", () => {
    // A key used only to decide whether to render a navigation item hides the
    // link and stops nothing: anybody can type the address. `dashboard.view`
    // was exactly that until the dashboard page began asking for it, and it
    // only started to matter when custom roles made it possible to build a
    // role without it.
    const drawingOnly = ALL_PERMISSION_KEYS.filter(
      (key) => !NO_CHECK_NEEDED[key] && !direct.has(key) && byTable.has(key),
    );

    // The report catalogue is the exception that is genuinely a check:
    // `reports/access.ts` refuses on the entry's own permission before a
    // report is built, so a key reachable only that way is enforced.
    const reportKeys = new Set(
      [
        ...readFileSync("src/lib/reports/catalogue.ts", "utf8").matchAll(
          /permission: "([a-z_.]+)"/g,
        ),
      ].map((match) => match[1]!),
    );

    const unguarded = drawingOnly.filter((key) => !reportKeys.has(key));
    expect(
      unguarded,
      `hidden from the navigation but reachable at the URL: ${unguarded.join(", ")}`,
    ).toEqual([]);
  });

  it("gives a real reason for anything left unchecked", () => {
    for (const [key, reason] of Object.entries(NO_CHECK_NEEDED)) {
      expect(
        reason?.length,
        `${key} has no reason worth the name`,
      ).toBeGreaterThan(30);
    }
  });

  it("is not handed out by a role template unless it exists", () => {
    // The removed eight were in the Manager, Accountant, Auditor and Tax
    // Consultant templates, so every company since the first was carrying
    // grants that meant nothing.
    const catalogue = new Set<string>(ALL_PERMISSION_KEYS);
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      // Owner's list is null, meaning everything there is — including keys
      // added in later releases, which is why it cannot be a list.
      const unknown = (template.permissions ?? []).filter(
        (key) => !catalogue.has(key),
      );
      expect(
        unknown,
        `${template.key} grants permissions that are not in the catalogue: ${unknown.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("describes something in words, so the roles screen can render it", () => {
    // The checkbox list is built from these descriptions. A key with none
    // renders as its own identifier, which is not a sentence anybody outside
    // this repository can act on.
    for (const key of ALL_PERMISSION_KEYS) {
      expect(PERMISSIONS[key].description.length, key).toBeGreaterThan(5);
      expect(PERMISSIONS[key].module.length, key).toBeGreaterThan(1);
    }
  });
});
