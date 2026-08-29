import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every server action says who may call it, and where the call came from.
 *
 * A server action is a POST endpoint with a generated URL. Nothing about being
 * written as a function makes it safer than one, and the two questions every
 * one of them has to answer are the same two: may this caller do this, and did
 * this request come from us.
 *
 * They are answered five different ways across the codebase — `assertPermission`
 * with a literal, `assertPermission` with a key computed from an argument,
 * a local `guard` helper, `requirePlatformAdmin`, and `getCompanyContext` for
 * the shell actions that resolve a tenant and check nothing further. Origin is
 * two more: `requireSameOrigin`, which returns a failure, and `assertSameOrigin`,
 * which throws.
 *
 * That is the reason this file exists rather than a sentence saying the surface
 * is covered. Sweeping it by hand mistook four correctly guarded actions for
 * unguarded ones — the party actions compute their permission from the kind, the
 * document ones go through a local helper, the admin ones use the platform
 * check, and the auth ones use the throwing origin call. An action with no guard
 * at all looks exactly like those from the outside, so a person checking is as
 * likely to dismiss a real hole as to find one. A machine that knows all seven
 * spellings is not.
 *
 * Nothing here asserts a particular permission is right for a particular action.
 * That is a judgement about the business, and it belongs with somebody who knows
 * whether voiding an invoice should need the same rights as raising one. This
 * asserts only that the question was asked.
 */

const SOURCES = globSync("src/server/**/actions.ts", { cwd: process.cwd() });

/** Every way the codebase asks "may this caller do this". */
const AUTHORIZATION =
  /(assertPermission|requirePermission|requirePlatformAdmin|getCompanyContext|getAuthSession|guard)\s*\(/;

/** Both spellings of "did this come from us" — one returns, one throws. */
const SAME_ORIGIN = /(requireSameOrigin|assertSameOrigin)\s*\(/;

/**
 * Actions a person without a session has to be able to reach, with the reason.
 *
 * Named rather than inferred, for the reason the authorization sweep gives: an
 * omission and a decision look identical in a codebase, and only one of them
 * should pass.
 */
const PUBLIC: Record<string, string> = {
  signInAction: "Nobody is signed in yet. This is what signs them in.",
  registerAction:
    "Creates the account and the business. There is no session to check.",
  forgotPasswordAction:
    "Reached from the login page by somebody who cannot get in. It answers the same way whether or not the address is known.",
  resetPasswordAction:
    "Carries a token worth 32 random bytes, which is the credential. A session would defeat the point — the person has lost access.",
  verifyEmailAction: "As `resetPasswordAction`: the link is the proof.",
  acceptInvitationAction:
    "The invitee has no membership until this succeeds — that is what it creates. It verifies the invitation token and, for an existing account, the password.",
};

/**
 * Actions that read and change nothing, with the reason origin is not checked.
 *
 * A cross-origin form can post to these, and gains nothing by it: the browser
 * will not let the page that sent it read the response, and there is no write to
 * ride on. Every one of them still checks permission, so what comes back is
 * bounded by what the caller may see in the first place.
 */
const READ_ONLY: Record<string, string> = {
  bookQuantityAction:
    "Reads what a product holds, so the adjustment form can show it beside the count box.",
  adjustableProductsAction: "The stock-tracked products, for a picker.",
  searchPurchasableProductsAction: "Product search for the bill form.",
  searchSellableProductsAction: "Product search for the invoice form.",
  globalSearchAction:
    "The shell's search box. Results are already narrowed to the kinds the member may view.",
  openInvoicesAction:
    "Unsettled invoices, for the receipt form's allocation list.",
  openBillsAction: "Unsettled bills, for the payment form's allocation list.",
};

type Action = {
  name: string;
  file: string;
  authorized: boolean;
  origin: boolean;
};

function actions(): Action[] {
  const found: Action[] = [];
  for (const file of SOURCES) {
    const source = readFileSync(file, "utf8");
    const starts = [
      ...source.matchAll(/export async function (\w+Action)\s*\(/g),
    ];

    for (const [index, match] of starts.entries()) {
      // Bounded at the next action rather than by brace matching: an action's
      // body contains object literals, and the closing brace of one of those
      // is indistinguishable from the end of the function without a parser.
      const end = starts[index + 1]?.index ?? source.length;
      const body = source.slice(match.index + match[0].length, end);

      found.push({
        name: match[1]!,
        file,
        authorized: AUTHORIZATION.test(body),
        origin: SAME_ORIGIN.test(body),
      });
    }
  }
  return found;
}

describe("server actions", () => {
  const found = actions();

  it("are found at all", () => {
    // A scan that stopped matching would make every check below vacuously
    // true. There are seventy-nine of these; the floor is well under that so
    // the number is not a thing to update on every change.
    expect(found.length).toBeGreaterThanOrEqual(60);
    expect(found.map((action) => action.name)).toContain("createSaleAction");
  });

  it("all say who may call them, or are named as public", () => {
    const open = found
      .filter((action) => !action.authorized && !(action.name in PUBLIC))
      .map((action) => `${action.name} (${action.file})`);

    expect(open).toEqual([]);
  });

  it("all check the request came from us, or are named as reads", () => {
    // The public ones are included deliberately: signing in changes state, and
    // a cross-origin post to it is worth refusing even though the caller has
    // no session yet.
    const unchecked = found
      .filter((action) => !action.origin && !(action.name in READ_ONLY))
      .map((action) => `${action.name} (${action.file})`);

    expect(unchecked).toEqual([]);
  });

  it("keeps both exemption lists honest", () => {
    // An exemption for an action that has since been given the guard, or has
    // been renamed away, is a claim nobody has checked in a while.
    const byName = new Map(found.map((action) => [action.name, action]));

    const stalePublic = Object.keys(PUBLIC).filter((name) => {
      const action = byName.get(name);
      return !action || action.authorized;
    });
    const staleReads = Object.keys(READ_ONLY).filter((name) => {
      const action = byName.get(name);
      return !action || action.origin;
    });

    expect(stalePublic).toEqual([]);
    expect(staleReads).toEqual([]);
  });
});
