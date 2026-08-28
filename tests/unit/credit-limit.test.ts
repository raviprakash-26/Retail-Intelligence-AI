import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The credit limit is enforced on credit sales, and the form says so.
 *
 * It was not, for as long as it had existed. The field was captured on the
 * customer form, validated, read out of a CSV column with its own synonyms,
 * stored, and shown in the party list — and consulted by nothing. No posting
 * path selected it. A credit invoice that took a customer to twice their limit
 * was accepted without a word, while the form said:
 *
 *   > 0 means no limit is enforced.
 *
 * — which tells a shopkeeper, in as many words, that a non-zero one is.
 *
 * The previous version of this file held the *opposite* claim: that the field
 * was recorded and read by nothing, with the copy saying so. It did its job
 * when the enforcement landed — both halves failed at once and named
 * `sale-service.ts` and the sentence under the box. The claim has moved, so the
 * file moves with it, and the pairing is the part that stays: whatever the form
 * promises, something has to keep.
 */

/** The copy under the box, whitespace collapsed. */
function description(): string {
  const form = readFileSync(
    "src/components/master-data/party-manager.tsx",
    "utf8",
  );
  const at = form.indexOf('name="creditLimit"');
  expect(at).toBeGreaterThan(-1);
  return form.slice(at, at + 1200).replace(/\s+/g, " ");
}

describe("what the form promises about a credit limit", () => {
  it("is that an invoice over it is refused", () => {
    expect(description()).toMatch(/refused/i);
    // The two things a shopkeeper has to know beyond that, because both change
    // what they do: nought is not a limit of nought, and a counter sale is
    // never blocked by one.
    expect(description()).toMatch(/0 means no limit/i);
    expect(description()).toMatch(/[Cc]ash sales/);
  });

  it("is kept by the one path that raises an invoice", () => {
    // A promise on the form and no reader in the service is the state this
    // whole pairing exists to catch — it is what was shipped, and it is what
    // the previous version of this file recorded.
    const sale = readFileSync("src/server/sales/sale-service.ts", "utf8");

    expect(sale).toContain("creditLimit: true");
    expect(sale).toContain("CREDIT_LIMIT_EXCEEDED");
  });

  it("is tested against the figure every other page quotes", () => {
    // Not a fresh calculation. `owedByParty` is the control account's balance
    // for the customer, which is what the ageing report, the reminder and the
    // customer statement all show — so a refusal can be argued with by looking
    // at any of them.
    const sale = readFileSync("src/server/sales/sale-service.ts", "utf8");
    expect(sale).toContain("owedByParty(tx, {");

    const outstanding = readFileSync(
      "src/server/settlements/outstanding.ts",
      "utf8",
    );
    expect(outstanding).toContain("export async function owedByParty");
    // Through the same control-account read the ageing residual uses, rather
    // than a second query that could drift from it.
    expect(outstanding).toMatch(
      /owedByParty[\s\S]{0,600}controlAccountByParty\(/,
    );
  });
});

/**
 * Where the field may be read without deciding anything.
 *
 * Storing it, listing it, validating it and importing it are not enforcement.
 * `sale-service` is the one path that acts on it, and it is named rather than
 * pattern-matched so that a *second* path acting on it has to be added here
 * deliberately — two places deciding what a customer may be trusted with is how
 * they come to decide differently.
 */
const READERS: Record<string, string> = {
  "src/server/master-data/party-service.ts":
    "Writes the field and reads it back for the party list. The doc comment on `PartyRow.creditLimit` states what it now does.",
  "src/server/import/import-service.ts":
    "Reads the column out of a CSV into the same input the form submits.",
  "src/lib/validation/master-data.ts": "The field's own schema.",
  "src/lib/import/datasets.ts":
    "The column's header synonyms, so a spreadsheet that calls it 'limit' still lands here.",
  "src/server/sales/sale-service.ts":
    "Enforces it. The only path that refuses on the strength of it.",
};

const FIELD = /\bcreditLimit\b/;

describe("who reads a credit limit", () => {
  it("has enough server files for this to mean anything", () => {
    const files = globSync("src/{server,lib}/**/*.ts", { cwd: process.cwd() });
    expect(files.length).toBeGreaterThan(100);
  });

  it("is nobody beyond the places named here", () => {
    const found: string[] = [];
    for (const file of globSync("src/{server,lib}/**/*.ts", {
      cwd: process.cwd(),
    })) {
      if (file in READERS) continue;
      const source = readFileSync(file, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        // The rule described is not the rule broken.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (FIELD.test(line)) found.push(`${file}:${index + 1}`);
      }
    }

    expect(found).toEqual([]);
  });

  it("keeps the list honest", () => {
    const stale = Object.keys(READERS).filter(
      (file) => !FIELD.test(readFileSync(file, "utf8")),
    );

    expect(stale).toEqual([]);
  });
});
