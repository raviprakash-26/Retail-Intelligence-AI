import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every raw query is parameterised, and every one of them is tenant-scoped.
 *
 * This codebase drops to SQL where an ORM would be worse: running balances,
 * window functions, the auditor's checks. Prisma's tagged-template
 * `$queryRaw` parameterises interpolations, so those are safe by construction.
 * `$queryRawUnsafe` and `$executeRawUnsafe` are not — they take a string, and a
 * string is where injection lives.
 *
 * The second check is the one specific to this application. A raw query that
 * forgets `companyId` does not fail, does not look wrong, and quietly returns
 * another business's rows. Every raw query here reads from a tenant-owned
 * table, so every one of them must name the column.
 */

const SOURCES = globSync("src/**/*.ts", { cwd: process.cwd() });

/** Tables that belong to one business and must never be read without scoping. */
const TENANT_TABLES = [
  "journal_lines",
  "journal_entries",
  "sales",
  "sale_items",
  "purchases",
  "purchase_items",
  "expenses",
  "receipts",
  "payments",
  "receipt_allocations",
  "payment_allocations",
  "inventory_movements",
  "inventory_balances",
  "products",
  "customers",
  "suppliers",
  "accounts",
] as const;

type RawQuery = { file: string; sql: string };

function rawQueries(): RawQuery[] {
  const found: RawQuery[] = [];

  for (const file of SOURCES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\$(?:queryRaw|executeRaw)(?:<[^>]*>)?`([\s\S]*?)`/g,
    )) {
      found.push({ file, sql: match[1] ?? "" });
    }
  }

  return found;
}

const QUERIES = rawQueries();

describe("raw SQL", () => {
  it("is used, so this test is not passing vacuously", () => {
    expect(QUERIES.length).toBeGreaterThan(5);
  });

  it("never goes through the unsafe variants", () => {
    const offenders = SOURCES.filter((file) =>
      /\$(?:queryRawUnsafe|executeRawUnsafe)/.test(readFileSync(file, "utf8")),
    );
    expect(offenders, "string-built SQL is where injection lives").toEqual([]);
  });

  it("scopes every query that touches a tenant-owned table", () => {
    const unscoped = QUERIES.filter((query) => {
      const touchesTenantTable = TENANT_TABLES.some((table) =>
        new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, "i").test(query.sql),
      );
      if (!touchesTenantTable) return false;
      return !/"companyId"/.test(query.sql);
    });

    expect(
      unscoped.map(
        (query) => `${query.file}: ${query.sql.trim().slice(0, 70)}…`,
      ),
      "a raw query reads a tenant table without naming companyId",
    ).toEqual([]);
  });

  it("interpolates through the template tag rather than string concatenation", () => {
    // `${x}` inside a Prisma tagged template becomes a bound parameter. String
    // addition inside one does not, and is the shape an injection takes here.
    const concatenated = QUERIES.filter((query) =>
      /\$\{[^}]*\+[^}]*\}/.test(query.sql),
    );
    expect(concatenated.map((query) => query.file)).toEqual([]);
  });
});
