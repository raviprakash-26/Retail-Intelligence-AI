import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A windowed balance read has to say what it does about closing entries.
 *
 * A closing entry moves every income and expense account by the whole of its
 * balance on one day. Asked for a *position* that is exactly right — it is what
 * puts the year's result into retained earnings, and the balance sheet depends
 * on it having happened. Asked for *movement over a window that contains that
 * day*, it cancels the window: a year's credit against whatever debits the
 * window holds.
 *
 * Three readers have now been caught by it, and none of them looked wrong:
 *
 *   • **The statements engine.** Revenue credited through the year and debited
 *     once on the last day netted to nil, so the moment a year was closed its
 *     own profit and loss account read empty.
 *   • **The income tax working paper.** Book depreciation is *added back* to
 *     profit and the Act's own figure deducted in its place. The add-back fell
 *     to nil while the deduction stayed, so the same depreciation came off
 *     twice and the taxable income was understated by the whole of it — in a
 *     document prepared after the year is closed, which is to say always.
 *   • **The cash projection.** Its running cost is thirteen weeks wide and ends
 *     today, so it contains the year end for the whole of the first quarter of
 *     every year. A quarter's debits against a year's credit is not nil but
 *     *negative*, and a negative running cost is added to each projected week
 *     rather than taken off it. The shortfall week disappeared and the shop was
 *     told it never runs out of cash.
 *
 * Each was written by somebody who had not met the other two, and each was
 * found separately. `excludeClosingEntries` is the answer, and the failure it
 * guards against is forgetting the question exists — which is invisible in any
 * single call site, because a read with no window has nothing to think about
 * and a read with one looks exactly the same.
 *
 * So a windowed call must state its answer. Not because the flag is always
 * right: the trial balance's is `false`, deliberately and for a good reason.
 * Because the decision has to be visible.
 */

/**
 * Windowed reads that deliberately keep closing entries, with the reason.
 *
 * Named rather than pattern-matched, for the reason the authorization sweep
 * gives: an omission and a decision look identical in a codebase, and only one
 * of them should pass.
 */
const DELIBERATE: Record<string, string> = {
  "src/server/accounting/trial-balance-service.ts":
    "A trial balance is a listing of the ledger, not an interpretation of it. The closing entry is a real entry and belongs in the movement columns beside every other one — leaving it out is what would make a post-closing trial balance stop balancing.",
};

const CALL = /\baccountBalances\s*\(/g;

/** The argument text of one call, comments stripped. */
function argumentsOf(source: string, openParen: number): string {
  let depth = 0;
  for (let index = openParen; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return source
          .slice(openParen + 1, index)
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/\/\/[^\n]*/g, " ");
      }
    }
  }
  // Unbalanced. Returning the rest of the file is the conservative answer: it
  // cannot make an unscoped call look scoped, only the other way round.
  return source.slice(openParen + 1);
}

type Site = {
  file: string;
  line: number;
  windowed: boolean;
  declares: boolean;
};

function callSites(): Site[] {
  const sites: Site[] = [];
  for (const file of globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })) {
    // The module the flag belongs to defines and documents it; it is not one of
    // its own callers.
    if (file === "src/server/accounting/balances.ts") continue;

    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(CALL)) {
      const args = argumentsOf(source, match.index + match[0].length - 1);
      sites.push({
        file,
        line: source.slice(0, match.index).split("\n").length,
        // A `from` key, however it is written: `from,` `from: x` `from: null`.
        windowed: /\bfrom\b\s*[:,}]/.test(args),
        declares: /\bexcludeClosingEntries\b/.test(args),
      });
    }
  }
  return sites;
}

describe("windowed balance reads", () => {
  const sites = callSites();

  it("finds enough call sites for this to mean anything", () => {
    // A scan that stops matching would make every check below vacuously true.
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(sites.some((site) => site.windowed)).toBe(true);
    // And it can see the flag when it is there, which is the half a broken
    // regular expression would fail silently.
    expect(sites.some((site) => site.windowed && site.declares)).toBe(true);
  });

  it("every one of them says what it does about closing entries", () => {
    const silent = sites
      .filter(
        (site) => site.windowed && !site.declares && !(site.file in DELIBERATE),
      )
      .map((site) => `${site.file}:${site.line}`);

    expect(silent).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a file that no longer reads a window is a claim nobody
    // has checked in a while.
    const stale = Object.keys(DELIBERATE).filter(
      (file) =>
        !sites.some(
          (site) => site.file === file && site.windowed && !site.declares,
        ),
    );

    expect(stale).toEqual([]);
  });
});

/**
 * The same rule, for the queries that do not go through `accountBalances`.
 *
 * The sweep above watches call sites. It could not see `revenueTrend`, which
 * reads `journal_lines` in raw SQL — and that is where the fourth reader of
 * this rule was found, months after the other three.
 *
 * `sales-analytics` states the guarantee about itself: revenue per week is
 * "the movement on the trading-account income accounts, exactly as the profit
 * and loss account defines it, so the buckets add up to the revenue on the
 * statements". The README repeats it. Both stopped being true the moment the
 * statements engine learned to leave closing entries out and this query did
 * not — before that they were wrong together, so they agreed, and the guarantee
 * held for the wrong reason.
 *
 * So a raw query that reads account movement over a window has to answer the
 * same question the call sites do.
 */

/** Raw queries over the ledger that need no such filter, and why. */
const RAW_DELIBERATE: Record<string, string> = {
  "src/server/accounting/ledger-service.ts":
    "The account ledger lists the entries themselves. A closing entry is a real entry and belongs in the list, on the date it was made — leaving it out would show a year's income account never returning to nil.",
  "src/server/auditor/checks.ts":
    "The running cash balance. A closing entry moves income and expense accounts into retained earnings and never touches cash, so it cannot appear in this query's rows at all.",
};

/** A raw query body, from the opening backtick to the closing one. */
function rawQueries(source: string): string[] {
  const found: string[] = [];
  const pattern = /\$(?:queryRaw|executeRaw)</g;
  for (const match of source.matchAll(/\$(?:queryRaw|executeRaw)[^`]*`/g)) {
    const start = match.index + match[0].length;
    const end = source.indexOf("`", start);
    if (end > start) found.push(source.slice(start, end));
  }
  void pattern;
  return found;
}

describe("windowed ledger reads in raw SQL", () => {
  const files = globSync("src/server/**/*.ts", { cwd: process.cwd() });

  /** Queries reading account movement across a date window. */
  function movementQueries(): Array<{ file: string; declares: boolean }> {
    const found: Array<{ file: string; declares: boolean }> = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const query of rawQueries(source)) {
        if (!/journal_lines/.test(query)) continue;
        if (!/entryDate"?\s*(>=|<=|>|<)/.test(query)) continue;
        found.push({
          file,
          declares: /CLOSING_ENTRY/.test(query),
        });
      }
    }
    return found;
  }

  it("finds the queries this is about", () => {
    // Three read the ledger in raw SQL and all three are windowed. A scan that
    // stopped matching would make the check below vacuously true.
    const queries = movementQueries();
    expect(queries.length).toBeGreaterThanOrEqual(3);
    expect(queries.some((query) => query.declares)).toBe(true);
  });

  it("every one of them says what it does about closing entries", () => {
    const silent = movementQueries()
      .filter((query) => !query.declares && !(query.file in RAW_DELIBERATE))
      .map((query) => query.file);

    expect(silent).toEqual([]);
  });

  it("keeps the raw exemption list honest", () => {
    const stale = Object.keys(RAW_DELIBERATE).filter(
      (file) =>
        !movementQueries().some(
          (query) => query.file === file && !query.declares,
        ),
    );

    expect(stale).toEqual([]);
  });
});
