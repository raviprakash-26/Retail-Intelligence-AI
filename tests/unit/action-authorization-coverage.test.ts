import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every action that touches a tenant's data asks who is calling.
 *
 * `action-origin-coverage` proves nobody forgot the origin check. This proves
 * nobody forgot the authorization one, and the second matters more: Next.js
 * applies its own origin check underneath ours, so that guard is the second of
 * two. There is no second authorization check. `assertPermission` is the whole
 * of what stands between a signed-in user and another tenant's ledger, and an
 * action that omits it is not degraded — it is open.
 *
 * The gap this closes is not hypothetical. Two modules already reach the guard
 * through a local `guard()` helper rather than calling it in the action body:
 * `rbac/role-actions` and `documents/actions`. Both are correct today. The
 * origin test names that exact shape as the thing to watch — "three different
 * local helpers doing the same thing is how one of them quietly stops being
 * called" — and then only watches it for origin. So the indirection is resolved
 * here rather than banned: an action may call a helper in its own file, and the
 * helper is what must hold the guard.
 *
 * Reading the sources cannot prove a guard is the *right* one. The integration
 * tests do that — tenant isolation, custom roles, plan gates. This proves the
 * twenty-second action written on a Friday has one at all.
 */

/**
 * Actions with no tenant permission to check, and why.
 *
 * Listed by name rather than inferred, for the reason the origin test gives: an
 * omission and a decision look identical in a codebase, and only one of them
 * should pass. Every one is reachable before there is a session to ask about,
 * which is the only reason that survives scrutiny — anything else has a caller
 * and can be asked who they are.
 */
const NO_SESSION_YET: Record<string, string> = {
  signInAction: "Runs before there is a session to carry a permission.",
  registerAction: "Creates the first company; the caller belongs to none yet.",
  forgotPasswordAction:
    "Reached by someone who cannot sign in, by definition unauthenticated.",
  resetPasswordAction:
    "Authorised by the emailed token it verifies, not by a session.",
  verifyEmailAction:
    "Authorised by the emailed token it verifies, not by a session.",
  acceptInvitationAction:
    "Turns an invitation into a membership; the caller has none until it does.",
};

/**
 * Establishing who is calling, however this action needs to.
 *
 * Matched by name so a rename cannot slip past. The bar is that the caller is
 * identified at all — not that the *right* permission was chosen, which is a
 * judgement per action that the integration tests cover and a regex cannot.
 * Getting that bar wrong in the lenient direction still catches the thing worth
 * catching: an action that asks nobody anything.
 */
const GUARD =
  /(assertPermission|requirePermission|requirePlatformAdmin|requireCompanyContext|getCompanyContext|getAuthSession|requireAuth)\s*\(/;

type Action = { file: string; name: string; body: string };

function sourcesOf(file: string): string {
  return readFileSync(file, "utf8");
}

function actionsInRepo(): Action[] {
  const files = globSync("src/server/**/*actions.ts", { cwd: process.cwd() });
  const actions: Action[] = [];

  for (const file of files) {
    const source = sourcesOf(file);
    const matches = [
      ...source.matchAll(/export async function (\w+Action)\s*\(/g),
    ];

    for (const [index, match] of matches.entries()) {
      const start = match.index;
      const end = matches[index + 1]?.index ?? source.length;
      actions.push({
        file,
        name: match[1] ?? "",
        body: source.slice(start, end),
      });
    }
  }

  return actions;
}

/**
 * Whether an action reaches the guard, directly or through its own file.
 *
 * One level of indirection is resolved, which is what the two modules using a
 * local `guard()` need and as far as anything should have to be chased. A
 * helper that calls a helper is a place for the check to get lost, and this
 * failing is the right answer to that.
 */
function reachesGuard(action: Action, source: string): boolean {
  if (GUARD.test(action.body)) return true;

  const helpers = [
    ...source.matchAll(/(?:async function|const)\s+(\w+)\s*[=(]/g),
  ].map((match) => match[1] ?? "");

  for (const helper of helpers) {
    if (!helper || helper.endsWith("Action")) continue;
    // Called by this action?
    if (!new RegExp(`\\b${helper}\\s*\\(`).test(action.body)) continue;

    const declaration = new RegExp(
      `(?:async function|const)\\s+${helper}\\s*[=(][\\s\\S]{0,1200}`,
    ).exec(source);
    if (declaration && GUARD.test(declaration[0])) return true;
  }

  return false;
}

const ACTIONS = actionsInRepo();
const SOURCE_BY_FILE = new Map(
  [...new Set(ACTIONS.map((action) => action.file))].map((file) => [
    file,
    sourcesOf(file),
  ]),
);

describe("server actions", () => {
  it("exist in enough number for this test to mean something", () => {
    expect(ACTIONS.length).toBeGreaterThan(40);
  });

  it("check what the caller may do, or are named as exempt with a reason", () => {
    const unguarded = ACTIONS.filter(
      (action) =>
        !(action.name in NO_SESSION_YET) &&
        !reachesGuard(action, SOURCE_BY_FILE.get(action.file) ?? ""),
    );

    expect(
      unguarded.map((action) => `${action.file}:${action.name}`),
      "these touch a tenant's data without asking what the caller may do",
    ).toEqual([]);
  });

  it("gives a reason for every action exempted", () => {
    for (const [name, reason] of Object.entries(NO_SESSION_YET)) {
      expect(reason.length, name).toBeGreaterThan(20);
      expect(
        ACTIONS.some((action) => action.name === name),
        `${name} is exempted but no longer exists`,
      ).toBe(true);
    }
  });

  it("does not exempt an action that has grown a permission check", () => {
    // The list is for actions that cannot have one. If a name on it starts
    // asserting a permission, it has a tenant after all and should come off.
    const guarded = ACTIONS.filter(
      (action) => action.name in NO_SESSION_YET && GUARD.test(action.body),
    );
    expect(guarded.map((action) => action.name)).toEqual([]);
  });
});
