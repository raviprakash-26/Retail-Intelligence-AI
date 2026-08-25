import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every query that can span tenants names the tenant.
 *
 * This is the property the whole product rests on, and until now nothing
 * checked it. `lib/db.ts` said tenant scoping was "enforced by the repository
 * layer" and pointed at `src/server/db/tenant.ts`; there is no such file and
 * there is no such layer. Scoping is done by hand, one `companyId` at a time,
 * in around five hundred places — which is a discipline, not a mechanism, and
 * a discipline is exactly the kind of thing that holds until the Friday it
 * does not.
 *
 * A full read of those five hundred found no hole, so this is not written
 * against a known bug. It is written because the cost of the first one is not
 * a wrong number that can be corrected — it is one shop reading another shop's
 * books, which cannot be undone once it has happened.
 *
 * **What is checked.** Operations that can match more than one row, on models
 * carrying a `companyId`. Those are the ones where a missing filter silently
 * widens to the whole table.
 *
 * **What is not, and why.** `update`, `delete` and `findUnique` addressed by a
 * primary key are point operations, and every one of them in this codebase is
 * preceded by a scoped read that throws when the row belongs to somebody else
 * — `findFirst({ where: { id, companyId } })`, then act on `row.id`. A static
 * check cannot see that chain without becoming a type-checker, and one that
 * guessed would either pass everything or fail honest code. They are covered
 * by the tenant-isolation integration tests instead, which is the right tool
 * for a question about sequence.
 *
 * The model list is read from the schema rather than written down, so a tenant
 * model added next month is covered without anybody remembering to add it.
 */

/** Operations that can return or change more than one row. */
const SPANNING = [
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
] as const;

/**
 * Queries that are scoped by something other than the company, with the reason.
 *
 * Named one by one rather than inferred by pattern, for the reason the
 * authorization sweep gives: an omission and a decision look identical in a
 * codebase, and only one of them should pass. Keyed by file and operation so a
 * line moving does not need an edit here.
 */
const SCOPED_BY_SOMETHING_ELSE: Record<string, string> = {
  // Platform administration, deliberately across every tenant. Behind
  // `requirePlatformAdmin`, which is a separate gate from tenant permissions.
  "src/server/admin/admin-service.ts::Subscription.groupBy":
    "Platform-wide subscription counts for the operator's own dashboard.",
  "src/server/admin/admin-service.ts::AuditLog.findMany":
    "The platform's own admin log, which belongs to no tenant.",

  // Authentication, which happens before a tenant has been chosen — or spans
  // every tenant the person belongs to. The user is the scope here.
  "src/server/auth/context.ts::Membership.findMany":
    "Which companies this user belongs to. Scoped by userId, which is the question.",
  "src/server/auth/actions.ts::VerificationToken.updateMany":
    "Password reset and email verification, scoped by userId or by the row a secret token hash resolved to.",
  "src/server/auth/session.ts::Session.updateMany":
    "Ends every session a user holds, across all their companies. Scoped by userId.",
  "src/server/auth/session.ts::Session.deleteMany":
    "Sweeps expired sessions for everyone. A housekeeping job, not a tenant read.",
  "src/server/company/team-service.ts::VerificationToken.updateMany":
    "Consumes an invitation by the row id a secret token hash resolved to.",

  // Child rows reached through a parent whose ownership was already proved by
  // a scoped read in the same function. The parent id is the scope.
  "src/server/settlements/settlement-service.ts::ReceiptAllocation.deleteMany":
    "Allocations of one receipt, read by companyId immediately above.",
  "src/server/settlements/settlement-service.ts::PaymentAllocation.deleteMany":
    "Allocations of one payment, read by companyId immediately above.",
  "src/server/sales/sale-service.ts::ReceiptAllocation.deleteMany":
    "Allocations against one sale, read by companyId immediately above.",
  "src/server/purchases/purchase-service.ts::PaymentAllocation.deleteMany":
    "Allocations against one bill, read by companyId immediately above.",
  "src/server/returns/purchase-return-service.ts::PurchaseReturnItem.findMany":
    "What has already come back on one bill; both callers read that bill by companyId first.",
  "src/server/returns/sales-return-service.ts::SalesReturnItem.findMany":
    "What has already come back on one invoice; both callers read it by companyId first.",
};

function tenantModels(): string[] {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const models: string[] = [];
  let current: string | null = null;
  let scoped = false;

  for (const line of schema.split("\n")) {
    const start = /^model\s+(\w+)/.exec(line.trim());
    if (start) {
      if (current && scoped) models.push(current);
      current = start[1] ?? null;
      scoped = false;
      continue;
    }
    if (current && /^\s*companyId\s/.test(line)) scoped = true;
  }
  if (current && scoped) models.push(current);
  return models;
}

/** The argument object of a call, from the opening paren to its match. */
function argumentAt(source: string, open: number): string {
  let depth = 1;
  let index = open;
  while (index < source.length && depth > 0) {
    const character = source[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
    }
    index += 1;
  }
  return source.slice(open, index - 1);
}

/**
 * A `const x = …` or `function x(…)` in the same file, bounded to itself.
 *
 * Bounded is the whole point. A fixed window from the declaration ran past the
 * end of the statement into whatever came next, so any file with a `companyId`
 * anywhere below the declaration looked scoped — which made this pass while
 * the journal register was deliberately unscoped. A statement ends at the
 * semicolon that closes it and a function at its matching brace; anything else
 * is reading somebody else's code and calling it proof.
 */
function declarationOf(source: string, name: string): string {
  const found = new RegExp(
    `(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*[:=])`,
  ).exec(source);
  if (!found) return "";

  let depth = 0;
  for (let index = found.index; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      // A function body closing at depth zero ends the declaration.
      if (depth === 0 && character === "}") {
        return source.slice(found.index, index + 1);
      }
    } else if (character === ";" && depth === 0) {
      return source.slice(found.index, index + 1);
    }
  }
  return source.slice(found.index);
}

/** Identifiers a where clause was built from: `where: x`, `{ where }`, `...x`. */
function referenced(argument: string): string[] {
  const names = new Set(
    [...argument.matchAll(/\.\.\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(
      (match) => match[1] ?? "",
    ),
  );
  const named = /where\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/.exec(argument);
  if (named?.[1]) names.add(named[1]);
  if (/(?:^|[{,]\s*)where\s*[,}]/.test(argument)) names.add("where");
  return [...names].filter(Boolean);
}

/**
 * Whether the tenant reaches this call, directly or through what built it.
 *
 * Two hops, which covers `const where = buildWhere(filters)` and
 * `{ ...baseWhere, entryDate }`. Anything deeper fails closed: the query is
 * reported, and the answer is to name the tenant in the call or to add a line
 * above with the reason.
 */
function namesTheTenant(source: string, argument: string, depth = 0): boolean {
  if (argument.includes("companyId")) return true;
  if (depth > 2) return false;

  for (const name of referenced(argument)) {
    const declaration = declarationOf(source, name);
    if (!declaration) continue;
    if (declaration.includes("companyId")) return true;

    const call = /=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(declaration);
    if (call?.[1] && declarationOf(source, call[1]).includes("companyId")) {
      return true;
    }
    if (namesTheTenant(source, declaration, depth + 1)) return true;
  }
  return false;
}

type Query = { key: string; file: string; line: number; scoped: boolean };

function spanningQueries(): Query[] {
  const models = tenantModels();
  const byClientName = new Map(
    models.map((model) => [model[0]!.toLowerCase() + model.slice(1), model]),
  );
  const pattern = new RegExp(
    `\\b(?:prisma|tx|client|db)\\.(${[...byClientName.keys()].join("|")})\\.(${SPANNING.join("|")})\\s*\\(`,
    "g",
  );

  const found: Query[] = [];
  for (const file of globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      const model = byClientName.get(match[1] ?? "");
      if (!model) continue;
      const argument = argumentAt(source, match.index + match[0].length);
      found.push({
        key: `${file}::${model}.${match[2]}`,
        file,
        line: source.slice(0, match.index).split("\n").length,
        scoped: namesTheTenant(source, argument),
      });
    }
  }
  return found;
}

const QUERIES = spanningQueries();

describe("tenant scoping", () => {
  it("has a model list and a query list worth checking", () => {
    // If either collapses, this test passes by having nothing to say. It
    // should fail instead — a green tick over an empty scan is worse than no
    // test at all.
    expect(tenantModels().length).toBeGreaterThan(40);
    expect(QUERIES.length).toBeGreaterThan(150);
  });

  it("names the company on every query that could span tenants", () => {
    const unscoped = QUERIES.filter(
      (query) => !query.scoped && !(query.key in SCOPED_BY_SOMETHING_ELSE),
    ).map(
      (query) => `${query.file}:${query.line} — ${query.key.split("::")[1]}`,
    );

    expect(unscoped).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a query that no longer exists is a claim nobody has
    // checked in a while. Removing it is the point of noticing.
    const live = new Set(QUERIES.filter((q) => !q.scoped).map((q) => q.key));
    const stale = Object.keys(SCOPED_BY_SOMETHING_ELSE).filter(
      (key) => !live.has(key),
    );

    expect(stale).toEqual([]);
  });

  it("names the company in raw SQL that touches a tenant table", () => {
    // Raw SQL goes nowhere near Prisma's `where`, so nothing above sees it.
    const tables = tenantModels().map((model) =>
      model
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .concat("s"),
    );

    const offenders: string[] = [];
    for (const file of globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /\$(?:query|execute)Raw(?:Unsafe)?(?:<[^>]*>)?\s*`([^`]*)`/g,
      )) {
        const sql = match[1] ?? "";
        const touches = tables.some((table) => sql.includes(table));
        if (touches && !/companyId|company_id/.test(sql)) {
          offenders.push(
            `${file}:${source.slice(0, match.index).split("\n").length}`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
