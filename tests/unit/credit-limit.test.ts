import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The credit limit is recorded, not enforced — and the form now says so.
 *
 * It is captured on the customer form, validated, read out of a CSV column with
 * its own synonyms, stored, and shown in the party list. Nothing else touches
 * it. No posting path selects it; a credit invoice that takes a customer to
 * twice their limit is accepted without a word.
 *
 * What made that a defect rather than an unbuilt feature is that the form said
 * otherwise. Under the box it read:
 *
 *   > 0 means no limit is enforced.
 *
 * — which tells a shopkeeper, in as many words, that a non-zero one is. Someone
 * typing ₹50,000 against a customer was being told the software would stop
 * them, and it never would. This module has a rule about that, in the AI
 * provider's own words: a thing that is switched off is better said than
 * faked.
 *
 * Two ways to make it true, and they are different products. A hard refusal on
 * a credit invoice over the limit, or a warning beside the stock shortages the
 * invoice form already lists without blocking. Whichever is chosen, the figure
 * to test against is what the customer owes *after* money paid on account, and
 * that has one definition already — `unappliedCredit` and
 * `afterUnappliedCredit` in `server/settlements/outstanding`.
 *
 * So this does not assert that the field is unused for ever. It asserts that
 * the claim and the behaviour move together: the day a posting path reads
 * `creditLimit`, this fails, and whoever wired it is sent to the sentence under
 * the box.
 */

/**
 * Where the field legitimately appears while it is only recorded.
 *
 * Writing it down, reading it back for a list, validating it and importing it
 * are all storage. Enforcement is a posting path consulting it before deciding
 * what a document may be.
 */
const RECORDING: Record<string, string> = {
  "src/server/master-data/party-service.ts":
    "Writes the field and reads it back for the party list. The doc comment on `PartyRow.creditLimit` is where the boundary is stated.",
  "src/server/import/import-service.ts":
    "Reads the column out of a CSV into the same input the form submits.",
  "src/lib/validation/master-data.ts": "The field's own schema.",
  "src/lib/import/datasets.ts":
    "The column's header synonyms, so a spreadsheet that calls it 'limit' still lands here.",
};

const FIELD = /\bcreditLimit\b/;

function readers(): string[] {
  const found: string[] = [];
  for (const file of globSync("src/{server,lib}/**/*.ts", {
    cwd: process.cwd(),
  })) {
    if (file in RECORDING) continue;
    const source = readFileSync(file, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      // The rule described is not the rule broken.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (FIELD.test(line)) found.push(`${file}:${index + 1}`);
    }
  }
  return found;
}

describe("the credit limit", () => {
  it("has enough server files for this to mean anything", () => {
    // A glob that stops matching would make the check below vacuously true.
    const files = globSync("src/{server,lib}/**/*.ts", { cwd: process.cwd() });
    expect(files.length).toBeGreaterThan(100);
  });

  it("is read by nothing that decides what a document may be", () => {
    // If this fails, the field has grown a reader. That is welcome — and the
    // sentence under the box in `party-manager.tsx` has to stop saying nothing
    // stops an invoice, because now something does.
    expect(readers()).toEqual([]);
  });

  it("says as much on the form that captures it", () => {
    const form = readFileSync(
      "src/components/master-data/party-manager.tsx",
      "utf8",
    );

    // Whitespace collapsed first: the sentence is wrapped across source lines
    // and re-wrapped by the formatter whenever a word changes, so matching the
    // raw text would be a test of where Prettier put the newline.
    const field = form.indexOf('name="creditLimit"');
    expect(field).toBeGreaterThan(-1);
    const description = form.slice(field, field + 1200).replace(/\s+/g, " ");

    // The exact sentence matters less than what it cannot claim: the old copy
    // turned on the word "enforced", and a field nothing reads must not use it.
    expect(description).not.toMatch(/enforced/i);
    expect(description).toMatch(/Nothing stops an invoice/i);
  });

  it("keeps the recording list honest", () => {
    // An entry for a file that no longer mentions the field is a claim nobody
    // has checked in a while.
    const stale = Object.keys(RECORDING).filter(
      (file) => !FIELD.test(readFileSync(file, "utf8")),
    );

    expect(stale).toEqual([]);
  });
});
