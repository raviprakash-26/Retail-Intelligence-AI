import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FEATURE,
  PLAN_DEFINITIONS,
  type FeatureKey,
} from "@/lib/billing/plans";

/**
 * Every feature the plans sell is either enforced or declared unenforceable.
 *
 * The pricing page sold "Custom roles & permissions" as a Business-plan feature
 * from the beginning, and no such thing existed — no page, no action, no
 * service, and `roles.manage` appeared nowhere outside the permission
 * catalogue. Nothing failed, because nothing was looking. A product whose whole
 * character is refusing to overclaim had a public page charging for something
 * it did not do.
 *
 * This is the check that would have caught it. Every key in `FEATURE` must
 * either be gated somewhere in the application, or be named below with the
 * reason it needs no gate. A feature added to the pricing page and to nothing
 * else fails here.
 *
 * It reads the source rather than exercising the gates. The integration tests
 * prove a gate behaves; this proves nobody forgot to write one.
 */

/**
 * Features that need no gate, and why.
 *
 * Listed rather than inferred from the absence of a call, for the same reason
 * the read-only actions are: an omission and a decision look identical in a
 * codebase, and only one of them should pass.
 */
const NO_GATE_NEEDED: Partial<Record<FeatureKey, string>> = {
  [FEATURE.CORE_TRANSACTIONS]:
    "In every plan including the cheapest, so there is nothing to withhold.",
  [FEATURE.ACCOUNTING_BASIC]:
    "In every plan. A double-entry ledger is what this product is.",
  [FEATURE.ACCOUNTING_STATEMENTS]:
    "In every plan — statements come from the ledger everybody has.",
  [FEATURE.EXPORTS]:
    "In every plan. A business's own figures are not a thing to ration.",
  [FEATURE.PRIORITY_SUPPORT]:
    "A commitment by people, not a capability in software. Nothing here can enforce it.",
};

function sourceFiles(): string[] {
  return globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() }).filter(
    (file) => !file.endsWith("lib/billing/plans.ts"),
  );
}

/** Every feature key mentioned anywhere that is not the plan definition. */
function referencedFeatures(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    for (const [name] of Object.entries(FEATURE)) {
      if (text.includes(`FEATURE.${name}`)) {
        found.set(name, [...(found.get(name) ?? []), file]);
      }
    }
  }
  return found;
}

/**
 * A mention on the pricing page is a claim, not a gate.
 *
 * This is the distinction the whole test turns on: the page listing a feature
 * is what makes the promise, so it cannot also be the thing that discharges it.
 *
 * Matched loosely on purpose. The first version of this looked for
 * `marketing/pricing` and the real path is `(marketing)/pricing` — so the
 * pricing page counted as a gate and the test passed while the feature it was
 * written for did not exist. It was caught by deleting the feature and
 * watching nothing fail.
 */
const CLAIM_ONLY = /pricing[\\/]/;

describe("every feature the plans sell", () => {
  const referenced = referencedFeatures();

  it("is enforced somewhere, or says why it needs no gate", () => {
    const unenforced: string[] = [];

    for (const [name, key] of Object.entries(FEATURE) as Array<
      [string, FeatureKey]
    >) {
      if (NO_GATE_NEEDED[key]) continue;

      const files = referenced.get(name) ?? [];
      const gates = files.filter((file) => !CLAIM_ONLY.test(file));
      if (gates.length === 0) unenforced.push(name);
    }

    expect(
      unenforced,
      `sold on the pricing page and gated nowhere: ${unenforced.join(", ")}`,
    ).toEqual([]);
  });

  it("gives a real reason for anything left ungated", () => {
    for (const [key, reason] of Object.entries(NO_GATE_NEEDED)) {
      expect(
        reason?.length,
        `${key} has no reason worth the name`,
      ).toBeGreaterThan(30);
    }
  });

  it("does not excuse a feature that is only in some plans", () => {
    // The exemptions above lean on "it is in every plan". If one is ever moved
    // to a higher tier, the excuse stops being true and this says so.
    const everyPlan = PLAN_DEFINITIONS.length;

    for (const key of Object.keys(NO_GATE_NEEDED) as FeatureKey[]) {
      if (key === FEATURE.PRIORITY_SUPPORT) continue; // not a software feature

      const plansWithIt = PLAN_DEFINITIONS.filter((plan) =>
        plan.features.includes(key),
      ).length;

      expect(
        plansWithIt,
        `${key} is excused as being in every plan, but only ${plansWithIt} of ${everyPlan} include it`,
      ).toBe(everyPlan);
    }
  });

  it("knows custom roles are now a real feature", () => {
    // The one this test was written for. It was sold and did not exist.
    const files = referenced.get("ADVANCED_PERMISSIONS") ?? [];
    expect(files.some((file) => !CLAIM_ONLY.test(file))).toBe(true);
  });
});
