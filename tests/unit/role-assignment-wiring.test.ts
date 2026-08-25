import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The permissions handed to the role-assignment guards are the caller's own.
 *
 * `inviteMember` and `changeMemberRole` refuse to put anybody into a role
 * carrying permissions the actor does not hold, and the integration tests prove
 * that refusal works. What they cannot prove is that the set the guard was
 * measuring against was the actor's. A guard given every permission agrees with
 * everything, and it does so silently: the invitation is issued, the promotion
 * lands, no test anywhere goes red. Verified by writing exactly that mistake —
 * substituting `new Set(ALL_PERMISSION_KEYS)` at both call sites in the actions
 * layer — and watching the whole team and custom-role suites pass.
 *
 * That is not a hypothetical slip. `holder` is a set of permission keys and so
 * is every other permission set in the codebase, so the wrong one type-checks;
 * and the honest-looking value to reach for when a set is needed in a hurry is
 * the catalogue. The service layer cannot defend itself here, because by the
 * time it has the set it has no way to ask where it came from.
 *
 * So the wiring is checked in the only place it is visible: the source. Matched
 * literally rather than by parsing, because the point is not that some
 * expression is passed but that this exact one is — the context object built by
 * `assertPermission`, which reads the actor's own membership.
 */

const CALLERS = /\b(inviteMember|changeMemberRole)\s*\(\s*\{/g;

/** What the actor actually holds, and the only thing either guard may be given. */
const ACTOR_PERMISSIONS = "holder: context.permissions,";

type CallSite = { file: string; callee: string; argument: string };

/** The object literal passed to a call, from its opening brace to its match. */
function objectArgument(source: string, openBrace: number): string {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace, index + 1);
    }
  }
  return source.slice(openBrace);
}

function callSites(): CallSite[] {
  const files = globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() }).filter(
    // The declarations themselves, not calls of them.
    (file) => !file.endsWith("company/team-service.ts"),
  );

  const sites: CallSite[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(CALLERS)) {
      const openBrace = source.indexOf("{", match.index);
      sites.push({
        file,
        callee: match[1] ?? "",
        argument: objectArgument(source, openBrace),
      });
    }
  }
  return sites;
}

const SITES = callSites();

describe("role assignment", () => {
  it("has call sites for this test to have anything to say", () => {
    // Both guarded functions, reached from the actions layer. Should either
    // stop being called from `src`, this is the test that has quietly become
    // vacuous, and it should fail rather than keep passing.
    expect(SITES.map((site) => site.callee).sort()).toEqual([
      "changeMemberRole",
      "inviteMember",
    ]);
  });

  it("measures every assignment against the acting user's own permissions", () => {
    const wrong = SITES.filter(
      (site) => !site.argument.includes(ACTOR_PERMISSIONS),
    ).map((site) => `${site.file}: ${site.callee}`);

    expect(wrong).toEqual([]);
  });
});
