import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every action that changes something checks where the request came from.
 *
 * Next.js applies its own origin check to Server Actions. This is the second,
 * explicit layer, and it exists because the first one is a framework default
 * somebody could turn off, misconfigure behind a proxy, or lose in an upgrade.
 *
 * The check is worth having a test for because it is exactly the kind of line
 * that gets left out of the twenty-first action written on a Friday. Reading
 * the sources cannot prove the guard behaves correctly — the integration tests
 * do that — but it can prove nobody forgot to call it.
 *
 * Read-only actions are listed here by name rather than inferred from the
 * absence of a call. A cross-origin page can cause a read but cannot see the
 * response, so those do not need the check; putting them in a list means each
 * one was a decision somebody made and can be argued with, instead of an
 * omission indistinguishable from a mistake.
 */

const READ_ONLY: Record<string, string> = {
  searchSellableProductsAction:
    "Searches this company's products for a picker.",
  searchPurchasableProductsAction: "The same picker, on the purchase form.",
  adjustableProductsAction: "Lists stock-tracked products for the count form.",
  bookQuantityAction: "Reads what the books say a product's quantity is.",
  journalPartiesAction: "Lists parties for the manual journal picker.",
  openInvoicesAction: "Lists a customer's unsettled invoices.",
  openBillsAction: "Lists a supplier's unpaid bills.",
  globalSearchAction: "The search box. Reads, tenant-scoped, writes nothing.",
};

type Action = { file: string; name: string; body: string };

function actionsInRepo(): Action[] {
  const files = globSync("src/server/**/*actions.ts", { cwd: process.cwd() });
  const actions: Action[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
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

const ACTIONS = actionsInRepo();

describe("server actions", () => {
  it("exist in enough number for this test to mean something", () => {
    expect(ACTIONS.length).toBeGreaterThan(40);
  });

  it("check the origin, or are named as read-only with a reason", () => {
    const unguarded = ACTIONS.filter(
      (action) =>
        !action.body.includes("requireSameOrigin()") &&
        !action.body.includes("assertSameOrigin()") &&
        !(action.name in READ_ONLY),
    );

    expect(
      unguarded.map((action) => `${action.file}:${action.name}`),
      "these change something without checking where the request came from",
    ).toEqual([]);
  });

  it("uses one spelling of the check, so this test can see it", () => {
    // Three different local helpers doing the same thing is how one of them
    // quietly stops being called.
    const localGuards = ACTIONS.filter(
      (action) =>
        action.body.includes("isSameOrigin(") &&
        !action.body.includes("requireSameOrigin()"),
    );
    expect(localGuards.map((action) => action.name)).toEqual([]);
  });

  it("does not list a read-only action that has since started writing", () => {
    // A cheap version of the same worry in the other direction: if one of
    // these grows a mutation, the name should come off the list.
    const writing = ACTIONS.filter(
      (action) =>
        action.name in READ_ONLY &&
        /prisma\.\w+\.(create|update|delete|upsert|createMany|updateMany|deleteMany)/.test(
          action.body,
        ),
    );
    expect(writing.map((action) => action.name)).toEqual([]);
  });

  it("gives a reason for every action exempted", () => {
    for (const [name, reason] of Object.entries(READ_ONLY)) {
      expect(reason.length, name).toBeGreaterThan(20);
      expect(
        ACTIONS.some((action) => action.name === name),
        `${name} is exempted but no longer exists`,
      ).toBe(true);
    }
  });
});
