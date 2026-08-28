import { globSync, readFileSync } from "node:fs";
import { CompanyStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { companyIsReachable } from "@/server/company/company-access";

/**
 * Whether a company can be worked in is one question with one answer.
 *
 * `setCompanyStatus` states what suspension is for, about itself:
 *
 *   > Suspension stops people signing in to it. It does not delete anything,
 *   > and it is reversible by the next administrator who disagrees.
 *
 * It stopped nothing. Four places decided whether a company was reachable, and
 * every one of them asked a narrower question or no question at all:
 *
 *   • the tenant context every `assertPermission` is built on — `CANCELLED`
 *   • the list of companies to switch between — `CANCELLED`
 *   • the invitation preview — `CANCELLED`
 *   • accepting an invitation — nothing, so a cancelled business could take on
 *     a member too
 *
 * A suspended business's members went on signing in and posting invoices. The
 * administrator pressed the button, watched the status change and the audit row
 * appear, and the shop carried on trading.
 *
 * Three "suspended" ideas exist in this product and the other two work:
 * `session.ts` refuses a suspended user everywhere, and `team-service` a
 * suspended membership. This was the third, and it was decorative.
 */

describe("whether a company can be worked in", () => {
  it("is decided for every status the enum has", () => {
    // An allow-list rather than a deny-list, so a fifth status added next year
    // is not silently reachable. This case is what makes that true rather than
    // intended: it fails on a value the table has not been taught.
    for (const status of Object.values(CompanyStatus)) {
      expect(typeof companyIsReachable(status)).toBe("boolean");
    }
  });

  it("lets a trading business through", () => {
    expect(companyIsReachable(CompanyStatus.ACTIVE)).toBe(true);
    expect(companyIsReachable(CompanyStatus.ONBOARDING)).toBe(true);
  });

  it("stops a suspended one, as the administrator was told it would", () => {
    expect(companyIsReachable(CompanyStatus.SUSPENDED)).toBe(false);
  });

  it("stops a cancelled one", () => {
    expect(companyIsReachable(CompanyStatus.CANCELLED)).toBe(false);
  });
});

/**
 * A comparison of a company's status against a literal, however it is spelled.
 *
 * There is no exemption list, and that is the finding rather than an oversight.
 * The definition classifies statuses through a table keyed by the enum, the
 * administrator's service counts them off a `groupBy` row, and provisioning
 * assigns one — none of those compares a *company's* status to a value, so
 * nothing legitimate trips this. An exemption list here would only be a list of
 * places allowed to reintroduce the bug, and the first draft of this file
 * proved that: `context.ts` was on it, and a mutation putting
 * `=== "CANCELLED"` straight back into the tenant context went unnoticed.
 */
const COMPARISON =
  /\b(?:company|record\.company|membership\.company)\??\.status\s*[!=]==/;

function decidesForItself(): string[] {
  const found: string[] = [];
  for (const file of globSync("src/{server,app,lib}/**/*.{ts,tsx}", {
    cwd: process.cwd(),
  })) {
    const source = readFileSync(file, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      // The rule described is not the rule broken.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (COMPARISON.test(line)) found.push(`${file}:${index + 1}`);
    }
  }
  return found;
}

describe("who gets to decide it", () => {
  it("has enough files for this to mean anything", () => {
    const files = globSync("src/{server,app,lib}/**/*.{ts,tsx}", {
      cwd: process.cwd(),
    });
    expect(files.length).toBeGreaterThan(200);
  });

  it("is nobody deciding it for themselves", () => {
    // A fifth reader comparing a status to a literal is how the first four came
    // to disagree. There is a function for it now.
    expect(decidesForItself()).toEqual([]);
  });

  it("is asked by every place that gates on it", () => {
    // The other half. Banning the comparison would be satisfied by a reader
    // that asks nothing at all, which is exactly how `acceptInvitation` let a
    // member into a cancelled business.
    const context = readFileSync("src/server/auth/context.ts", "utf8");
    const team = readFileSync("src/server/company/team-service.ts", "utf8");

    // Twice in the context: the switcher list and the tenant context.
    expect(context.match(/companyIsReachable\(/g)?.length).toBe(2);
    // Twice in team management: previewing an invitation and accepting one.
    expect(team.match(/companyIsReachable\(/g)?.length).toBe(2);
  });
});
