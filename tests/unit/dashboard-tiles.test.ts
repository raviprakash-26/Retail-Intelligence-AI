import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A blank tile has to be blank for a reason that is still true.
 *
 * The dashboard shipped before the modules behind it, so eight of its twelve
 * tiles rendered a skeleton and a note naming what they waited for: "Arrives
 * with the Sales module", "Arrives with the Purchases module", "Arrives with
 * the Inventory module", "Arrives with the GST module". Every one of those
 * shipped. The notes did not change, and nothing failed, because nothing was
 * looking — so the first screen after signing in went on telling a shop that
 * had been trading for months that most of its figures were not built yet.
 *
 * The pending state itself is worth keeping: a ₹0 tile is indistinguishable
 * from a business that genuinely earned nothing. What it may not do is wait on
 * something that already exists.
 */

const DASHBOARD = join(process.cwd(), "src/app/(app)/app/page.tsx");

/**
 * Reasons a tile may be pending, and why each is legitimate.
 *
 * A reason belongs here only if it describes a condition of *this business's
 * books* that can change today — not a feature somebody still has to build. Add
 * to it and you are arguing in writing that the blank is honest.
 */
const REASONS_A_TILE_MAY_BE_BLANK: Readonly<Record<string, string>> = {
  "Needs a ledger that balances.":
    "The statements refuse to be produced from a ledger whose sides disagree, " +
    "rather than rounding. The trial balance tile beside it says the same " +
    "thing, and the alert above it says what to do.",
};

/** Every `pendingNote="…"` written on the dashboard. */
function pendingNotes(): string[] {
  const source = readFileSync(DASHBOARD, "utf8");
  return [...source.matchAll(/pendingNote="([^"]+)"/g)].map(
    (match) => match[1]!,
  );
}

describe("a pending tile on the dashboard", () => {
  it("gives a reason that has been argued for", () => {
    const unexplained = pendingNotes().filter(
      (note) => !(note in REASONS_A_TILE_MAY_BE_BLANK),
    );

    expect(
      unexplained,
      "A tile is blank for a reason nobody has justified. Either fill the tile " +
        "in, or add its note to REASONS_A_TILE_MAY_BE_BLANK saying why the " +
        "blank is honest.",
    ).toEqual([]);
  });

  it("is not phrased as waiting for something to be built", () => {
    // The exact shape of the original mistake: a note promising a module would
    // arrive, left in place after it did.
    //
    // The first version of this case asked instead whether a note named any
    // module the navigation lists as ready, and failed on "Needs a ledger that
    // balances" — which names the ledger while waiting on nothing. Mentioning a
    // module is not the defect. Promising one is.
    const WAITING =
      /\b(arrives with|coming soon|not yet built|once .* is built|when .* ships|still to be built)\b/i;

    for (const note of pendingNotes()) {
      expect(
        WAITING.test(note),
        `"${note}" reads as waiting for a feature rather than describing a ` +
          `condition of the books. Every module the dashboard once waited on ` +
          `has shipped.`,
      ).toBe(false);
    }
  });

  it("has tiles that are not pending at all, so this is not vacuous", () => {
    const source = readFileSync(DASHBOARD, "utf8");
    const tiles = [...source.matchAll(/<KpiCard/g)].length;

    expect(tiles).toBeGreaterThan(8);
    expect(pendingNotes().length).toBeLessThan(tiles);
  });
});
