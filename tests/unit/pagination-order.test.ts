import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every paged query orders by something unique.
 *
 * `OFFSET` counts rows in whatever order the query produced them, and where the
 * sort key ties that order is undefined — it need not even hold between two
 * queries over unchanged data, and an edit between two page loads reliably
 * changes it. The result is a row shown on both pages and another shown on
 * neither: a shop carrying thirty products called "Sugar" saw a list that said
 * thirty and held twenty-nine.
 *
 * Sorting by a name, a date or a status is not enough. The order has to end in
 * a column the database guarantees is unique within the rows being paged, so
 * that "the twenty-sixth row" means the same thing twice running.
 *
 * The list below is those columns, per model, taken from the `@@unique` and
 * `@@id` constraints in the schema. Adding a model here is a claim about the
 * schema, so it is checked against the schema rather than trusted.
 */
const UNIQUE_TIEBREAKERS: Record<string, readonly string[]> = {
  sale: ["invoiceNumber", "id"],
  purchase: ["billNumber", "id"],
  expense: ["voucherNumber", "id"],
  receipt: ["voucherNumber", "id"],
  payment: ["voucherNumber", "id"],
  salesReturn: ["returnNumber", "id"],
  purchaseReturn: ["returnNumber", "id"],
  journalEntry: ["entryNumber", "id"],
  product: ["sku", "id"],
  employee: ["employeeCode", "id"],
  company: ["id"],
  auditLog: ["id"],
  inventoryMovement: ["id"],
  bankTransaction: ["id"],
  customer: ["code", "id"],
  supplier: ["code", "id"],
};

type PagedQuery = { file: string; line: number; model: string; order: string };

/** Every `findMany` that pages with `skip`, and the ordering it uses. */
function pagedQueries(): PagedQuery[] {
  const found: PagedQuery[] = [];

  for (const file of globSync("src/**/*.ts", { cwd: process.cwd() })) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\.(\w+)\.findMany\(/g)) {
      const model = match[1]!;
      // Balance the call's parentheses so a nested object cannot end it early.
      let depth = 0;
      let end = match.index! + match[0].length - 1;
      while (end < source.length) {
        if (source[end] === "(") depth += 1;
        else if (source[end] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        end += 1;
      }
      const block = source.slice(match.index!, end + 1);
      if (!/\bskip:/.test(block)) continue;

      const order = /orderBy:\s*(\[[\s\S]*?\]|\{[\s\S]*?\})/.exec(block);
      found.push({
        file,
        line: source.slice(0, match.index).split("\n").length,
        model,
        order: order ? order[1]! : "",
      });
    }
  }

  return found;
}

/** Paged queries whose ordering does not end in something unique. */
function offendersIn(queries: readonly PagedQuery[]): string[] {
  return queries
    .filter((query) => {
      const tiebreakers = UNIQUE_TIEBREAKERS[query.model];
      // A model nobody has classified is reported rather than passed.
      if (!tiebreakers) return true;
      return !tiebreakers.some((column) =>
        new RegExp(`\\b${column}\\s*:`).test(query.order),
      );
    })
    .map((query) => `${query.file}:${query.line} (${query.model})`)
    .sort();
}

describe("paged queries", () => {
  it("were found at all, so an empty pass means something", () => {
    // A sweep that quietly stopped matching would report no offenders and look
    // like success, so it has to prove it still sees the lists it is for.
    const models = new Set(pagedQueries().map((query) => query.model));
    for (const model of ["product", "employee", "sale", "purchase"]) {
      expect(models, `the sweep no longer sees ${model}`).toContain(model);
    }
  });

  it("every one of them orders by a column that is unique", () => {
    expect(offendersIn(pagedQueries())).toEqual([]);
  });

  it("reports a model nobody has classified rather than waving it through", () => {
    // The point is to notice a *new* paged list. A model absent from the table
    // above has not been thought about, and silence would be the wrong answer.
    expect(
      offendersIn([
        { file: "src/server/x.ts", line: 1, model: "widget", order: "" },
      ]),
    ).toEqual(["src/server/x.ts:1 (widget)"]);
  });

  it("names tiebreakers the schema actually makes unique", () => {
    // The list above is only worth having if it describes the database. A
    // column named here that the schema does not constrain would wave through
    // exactly the ordering this test exists to catch.
    const schema = readFileSync("prisma/schema.prisma", "utf8");

    for (const [model, columns] of Object.entries(UNIQUE_TIEBREAKERS)) {
      const name = model.charAt(0).toUpperCase() + model.slice(1);
      const block = new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, "m").exec(
        schema,
      );
      expect(block, `no model ${name} in the schema`).toBeTruthy();

      for (const column of columns) {
        const constrained =
          column === "id"
            ? /^\s*id\s+\S+\s+@id/m.test(block![0])
            : new RegExp(`@@unique\\(\\[[^\\]]*\\b${column}\\b`).test(
                block![0],
              );
        expect(
          constrained,
          `${name}.${column} is listed as a tiebreaker but the schema does not make it unique`,
        ).toBe(true);
      }
    }
  });
});
