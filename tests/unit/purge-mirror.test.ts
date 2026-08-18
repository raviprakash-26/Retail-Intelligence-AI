import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The test helper still deletes what the real purge deletes.
 *
 * `purgeCompany` cannot rely on the database cascade alone. Payslips restrict
 * their employee, payment events have no foreign key to a company at all, and
 * the activity log and sessions hang off one with `ON DELETE SET NULL` — so
 * deleting the company detaches those rows instead of removing them. Each of
 * those tables is therefore deleted by name, with the reason written beside it.
 *
 * `purgeTestCompany` says it mirrors that, and every integration test in the
 * repository cleans up through it. When the purge learned to delete the
 * activity log and sessions, the helper did not, and nothing said so: test
 * companies went on leaving their audit rows behind, detached, matching no
 * company, in a database every test file shares. Twenty thousand of them had
 * collected before anybody looked, and one file's run was adding forty-one.
 *
 * The residue was harmless to assertions, which is exactly why it survived —
 * the helper's own comment was the only thing claiming the two agreed. This is
 * that claim, enforced.
 */

const ROOT = process.cwd();
const PURGE = join(ROOT, "src/server/provisioning/purge-company.ts");
const HELPER = join(ROOT, "tests/helpers/test-db.ts");

/**
 * The tables a source file deletes by name inside its company purge.
 *
 * Read from `tx.<model>.deleteMany` calls. `purgeOrphanedUsers` and
 * `purgeTestUsers` live in the same files and delete users by a different rule,
 * so the scan stops at the `company.delete` that ends the purge — everything
 * after it belongs to a different operation.
 */
function tablesDeletedBeforeTheCompany(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const end = source.indexOf("company.delete");
  expect(end, `${path} does not delete the company`).toBeGreaterThan(-1);

  return [...source.slice(0, end).matchAll(/tx\.(\w+)\.deleteMany\(/g)].map(
    (match) => match[1]!,
  );
}

describe("purging a company in a test", () => {
  it("deletes the same tables the real purge deletes", () => {
    const real = tablesDeletedBeforeTheCompany(PURGE).sort();
    const helper = tablesDeletedBeforeTheCompany(HELPER).sort();

    expect(
      helper,
      "tests/helpers/test-db.ts says it mirrors purgeCompany. It does not — a " +
        "table the purge removes by name is left behind by every test that " +
        "cleans up through the helper, in a database every test file shares.",
    ).toEqual(real);
  });

  it("is checking a real list, not an empty one", () => {
    // Both files passing vacuously is the way this test would quietly stop
    // meaning anything: a rename of `deleteMany` would empty both sides and
    // leave them equal.
    expect(tablesDeletedBeforeTheCompany(PURGE).length).toBeGreaterThan(2);
  });
});
