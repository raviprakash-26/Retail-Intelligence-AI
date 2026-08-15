import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RULE_KEYS, RULES } from "@/lib/auditor/rules";

/**
 * Every advertised rule has a check behind it.
 *
 * This exists because one did not. `GST_REGISTER_MISMATCH` sat in the
 * catalogue from the first version of the auditor — with a severity, a
 * description and a recommendation — and nothing in the suite could ever
 * produce it. The rule list is shown to the reader, so a GST-registered shop
 * was being told its tax register was cross-checked against the ledger when no
 * query ever compared the two. Nothing failed; the check was simply absent,
 * which is the kind of gap a passing test suite is worst at noticing.
 *
 * Read from the source rather than from a list the checks export, because a
 * list can be added to without adding the check. The call site is the only
 * thing that proves a rule can actually fire.
 */

const CHECKS_SOURCE = readFileSync(
  path.join(process.cwd(), "src/server/auditor/checks.ts"),
  "utf8",
);

describe("the rule catalogue and the checks agree", () => {
  it("has a check that can produce every rule it advertises", () => {
    // Whitespace-tolerant: the formatter wraps the longer calls, so the key
    // does not always sit on the same line as the call.
    const orphans = RULE_KEYS.filter(
      (key) => !new RegExp(`finding\\(\\s*"${key}"`).test(CHECKS_SOURCE),
    );

    expect(
      orphans,
      `these rules are advertised but nothing can produce them: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("produces no rule that is missing from the catalogue", () => {
    // The other direction: a finding whose key has no rule would render with
    // no explanation and no recommendation beside it.
    const produced = [
      ...CHECKS_SOURCE.matchAll(/finding\(\s*"([A-Z_]+)"/g),
    ].map((match) => match[1] as string);

    for (const key of produced) {
      expect(
        RULE_KEYS,
        `${key} is produced but not in the catalogue`,
      ).toContain(key);
    }
  });

  it("wires every check into the suite that runs them", () => {
    // A check written but never added to CHECKS is the same failure wearing a
    // different hat: the code exists, reads correctly, and never runs.
    const defined = [...CHECKS_SOURCE.matchAll(/^async function (check\w+)/gm)]
      .map((match) => match[1] as string)
      .sort();

    const suiteBlock = CHECKS_SOURCE.slice(
      CHECKS_SOURCE.indexOf("export const CHECKS"),
    );
    const wired = [...suiteBlock.matchAll(/run: (check\w+)/g)]
      .map((match) => match[1] as string)
      .sort();

    expect(defined.length).toBeGreaterThan(0);
    expect(wired).toEqual(defined);
  });

  it("keeps a severity on every rule the checks can raise", () => {
    for (const key of RULE_KEYS) {
      expect(RULES[key].severity).toBeTruthy();
      expect(RULES[key].recommendation.length).toBeGreaterThan(20);
    }
  });
});
