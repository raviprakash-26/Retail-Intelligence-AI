import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_PERMISSION_KEYS } from "@/lib/rbac/permissions";
import {
  disconnectTestDb,
  ensurePlatformData,
  testDb,
} from "../helpers/test-db";

/**
 * The catalogue in code and the rows in the database say the same thing.
 *
 * A permission is a row. Guards ask whether a member's set contains a key, and
 * that set is assembled from `role_permissions`, so a key that exists in the
 * catalogue and has no row is one nobody can ever hold — every guard on it
 * refuses forever, and the module behind it is unreachable rather than
 * protected. The failure looks like a permissions bug and is really a
 * deployment one.
 *
 * Keeping them in step is a documented step of the deploy — run the migration,
 * then run the seed — and until now nothing checked that it had happened. A
 * documented procedure and a checked one are different things: this repository
 * found a dev database four keys behind while writing these tests, which is
 * exactly how it would look in production the day somebody deployed without
 * the second command.
 *
 * The other direction matters too. A row with no catalogue entry is a
 * permission that can be granted and has no description, so the roles screen
 * renders its identifier at somebody choosing what to hand out.
 */

const prisma = testDb();

beforeAll(async () => {
  await ensurePlatformData();
}, 120_000);

afterAll(async () => {
  await disconnectTestDb();
});

describe("the permission catalogue", () => {
  it("has a row for every key, and a key for every row", async () => {
    const rows = await prisma.permission.findMany({ select: { key: true } });
    const inDatabase = new Set(rows.map((row) => row.key));
    const inCatalogue = new Set<string>(ALL_PERMISSION_KEYS);

    const missingRows = [...inCatalogue].filter((key) => !inDatabase.has(key));
    const orphanedRows = [...inDatabase].filter((key) => !inCatalogue.has(key));

    expect(
      missingRows,
      `in the catalogue with no row, so nobody can hold them: ${missingRows.join(", ")}`,
    ).toEqual([]);
    expect(
      orphanedRows,
      `rows with no catalogue entry, so they render as identifiers: ${orphanedRows.join(", ")}`,
    ).toEqual([]);
  }, 120_000);

  it("no longer carries the eight that were checked by nothing", async () => {
    // Deleted by migration rather than left in place, because a grant that
    // means nothing is worse sitting in a role than absent from it: somebody
    // reading the role believes the person has been restricted.
    const removed = [
      "sales.edit",
      "purchases.edit",
      "expenses.edit",
      "gst.prepare",
      "gst.settings",
      "tax.prepare",
      "audit.view",
      "audit.resolve",
    ];

    const found = await prisma.permission.findMany({
      where: { key: { in: removed } },
      select: { key: true },
    });
    expect(found.map((row) => row.key)).toEqual([]);

    // And the grants went with them, which is what the cascade is for.
    const grants = await prisma.rolePermission.count({
      where: { permission: { key: { in: removed } } },
    });
    expect(grants).toBe(0);
  }, 120_000);
});
