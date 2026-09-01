import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every server action that can post has to ask billing first.
 *
 * `guards.ts` states the rule and says why it cannot live anywhere else: "All
 * three are asked on the server, in the action that does the work. The
 * navigation marks locked items and the pages render an explanation, but both
 * are presentation. A control that is merely hidden is not a lock — anybody can
 * type a URL or post the form themselves."
 *
 * The rule was kept by hand, and by hand it was kept unevenly. Two actions
 * reached `postJournalEntry` without asking:
 *
 *   • **`unmatchTransactionAction`.** Unmatching used to break a link and
 *     nothing else, so it needed no billing question. Then it was taught to
 *     reverse the entry a statement line had posted — and became a posting
 *     action without anybody moving the guard to match. Every sibling undo in
 *     the codebase asks: `voidSale`, `voidPurchase`, `voidExpense`,
 *     `voidPayroll`, `voidReceipt`, `voidPayment`, `reverseJournalEntry`.
 *
 *   • **`updatePartyAction`.** Editing a customer looks like master data and
 *     mostly is, but changing the opening balance posts an "Opening balance
 *     correction" through the same `postOpeningDelta` that `createParty` uses
 *     for the original entry. `createPartyAction` asks. The edit did not, so
 *     one entry had two routes into the books and only one of them was gated.
 *
 * Neither is visible by reading the action: one is a change of behaviour three
 * files away, the other is a branch inside a service that mostly updates a
 * phone number. So the question is asked of the source instead — which
 * functions an action can reach, and whether it asked before it got there.
 *
 * The converse is deliberately not asserted. Plenty of actions ask about a
 * feature or a numeric allowance without ever touching the ledger —
 * `askAccountant`, `createBranch`, `inviteMember` — and that is the guard's
 * other job.
 */

/** Reaching one of these is what makes an action a posting action. */
const LEDGER = new Set(["postJournalEntry", "reversePostedEntry"]);

/**
 * Actions that reach the ledger and are right not to ask, with the reason.
 *
 * Named rather than pattern-matched, for the reason the other sweeps in this
 * suite give: an omission and a decision look identical in a codebase, and
 * only one of them should pass.
 */
const DELIBERATE: Record<string, string> = {
  registerAction:
    "Registration posts the opening balances of a company that does not exist yet, for a subscription that cannot exist yet either. There is nothing to ask, and asking would refuse every new business at the door.",
};

const DECLARATION =
  /^(?:export )?(?:async )?function ([a-zA-Z_$][\w$]*)\s*[(<]/gm;
const CALL = /\b([a-zA-Z_$][\w$]*)\s*\(/g;

/**
 * Every top-level function in the server and library trees, by name.
 *
 * A name can be declared in more than one file, so each maps to a list and a
 * reach is a reach through any of them. That errs towards flagging, which is
 * the right direction: a false positive is one line in `DELIBERATE` with a
 * reason attached, and a false negative is an ungated posting action.
 */
function functionBodies(): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  const files = [
    ...globSync("src/server/**/*.ts", { cwd: process.cwd() }),
    ...globSync("src/lib/**/*.ts", { cwd: process.cwd() }),
  ];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const marks = [...text.matchAll(DECLARATION)].map((match) => ({
      at: match.index,
      name: match[1]!,
    }));
    marks.forEach((mark, index) => {
      const end = marks[index + 1]?.at ?? text.length;
      const body = text.slice(mark.at, end);
      const existing = bodies.get(mark.name);
      if (existing) existing.push(body);
      else bodies.set(mark.name, [body]);
    });
  }
  return bodies;
}

/** Can this function reach the ledger, through anything it calls? */
function reachesLedger(
  name: string,
  bodies: Map<string, string[]>,
  seen: Set<string>,
): boolean {
  if (LEDGER.has(name)) return true;
  if (seen.has(name)) return false;
  seen.add(name);

  for (const body of bodies.get(name) ?? []) {
    for (const call of new Set([...body.matchAll(CALL)].map((m) => m[1]!))) {
      if (call !== name && reachesLedger(call, bodies, seen)) return true;
    }
  }
  return false;
}

/**
 * The actions that reach the ledger without asking, given a set of exemptions.
 *
 * Extracted so the detector can be run against inputs that are known to be
 * wrong. `expect(offenders).toEqual([])` on its own cannot tell a clean
 * codebase from a broken sweep — weaken any filter in it and it still passes,
 * because a detector that flags nothing and a codebase with nothing to flag
 * look exactly the same from the outside.
 */
function offendersIn(
  bodies: Map<string, string[]>,
  deliberate: Readonly<Record<string, string>>,
): string[] {
  return [...bodies.keys()]
    .filter((name) => name.endsWith("Action"))
    .filter((name) => reachesLedger(name, bodies, new Set()))
    .filter(
      (name) =>
        !(bodies.get(name) ?? []).some((body) =>
          body.includes("billingRefusal"),
        ),
    )
    .filter((name) => !(name in deliberate))
    .sort();
}

describe("an action that can post asks billing before it does", () => {
  const bodies = functionBodies();
  const actions = [...bodies.keys()].filter((name) => name.endsWith("Action"));

  it("finds the actions in the first place", () => {
    // A sweep that matched nothing would pass in silence for ever. These four
    // are the shape it has to keep seeing: two that post and ask, one that
    // posts and is exempt, one that never goes near the ledger.
    expect(actions).toEqual(
      expect.arrayContaining([
        "createSaleAction",
        "voidSaleAction",
        "registerAction",
        "globalSearchAction",
      ]),
    );
    expect(actions.length).toBeGreaterThan(50);
  });

  it("still sees a path to the ledger where one exists", () => {
    // The reachability is the whole test, so it is worth pinning that it works
    // in both directions rather than trusting a sweep that could be finding
    // nothing because it resolves nothing.
    expect(reachesLedger("voidSaleAction", bodies, new Set())).toBe(true);
    expect(reachesLedger("createPartyAction", bodies, new Set())).toBe(true);
    expect(reachesLedger("globalSearchAction", bodies, new Set())).toBe(false);
  });

  it("flags a posting action that does not ask", () => {
    // The detector, run against something that is definitely wrong: an action
    // that calls the posting funnel and asks nothing first. Without this the
    // filters below could all be inverted and the suite would stay green.
    const planted = new Map(bodies);
    planted.set("plantedAction", [
      "export async function plantedAction() { await postJournalEntry(tx, {}); }",
    ]);
    expect(offendersIn(planted, DELIBERATE)).toEqual(["plantedAction"]);

    // And one that does ask is not flagged, so the guard is what clears it
    // rather than the name.
    const guarded = new Map(bodies);
    guarded.set("plantedAction", [
      "export async function plantedAction() { await billingRefusal(id, {}); await postJournalEntry(tx, {}); }",
    ]);
    expect(offendersIn(guarded, DELIBERATE)).toEqual([]);
  });

  it("exempts only what is named", () => {
    // With nothing exempt, the one deliberate case is the only thing standing.
    // This is what makes `DELIBERATE` load-bearing: empty the table and the
    // sweep must notice, rather than the table being decoration.
    expect(offendersIn(bodies, {})).toEqual(Object.keys(DELIBERATE).sort());
  });

  it("has no posting action left that does not ask", () => {
    expect(offendersIn(bodies, DELIBERATE)).toEqual([]);
  });

  it("keeps a reason beside every exemption", () => {
    for (const [name, reason] of Object.entries(DELIBERATE)) {
      expect(actions).toContain(name);
      expect(reachesLedger(name, bodies, new Set())).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
