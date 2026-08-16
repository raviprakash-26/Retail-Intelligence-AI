import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type { PermissionKey } from "@/lib/rbac/permissions";
import { registerOwner } from "@/server/auth/registration";
import {
  createRole,
  deleteRole,
  grantableBy,
  listRoles,
  updateRole,
  RoleError,
} from "@/server/rbac/role-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Roles a business defines for itself.
 *
 * The risk this feature carries is escalation. Somebody who can build a role
 * and hand it out could otherwise assemble one holding `billing.manage` and
 * `users.manage`, give it to themselves, and be an owner by lunchtime. Most of
 * what follows is about that.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function registrationInput(email: string): RegisterInput {
  return {
    account: {
      fullName: "Ravi Prakash",
      email,
      mobile: "9845012345",
      password: "MountainRiver42!",
      confirmPassword: "MountainRiver42!",
      acceptTerms: true,
    },
    business: {
      businessName: `Roles ${uniqueSlug("Mart")}`,
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: "29AAAPR1234K1ZP",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 20000,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

type Fixture = { companyId: string; userId: string; email: string };

async function shop(): Promise<Fixture> {
  const email = `roles-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return { companyId: result.companyId, userId: result.userId, email };
}

/** Everything, which is what an owner holds. */
async function ownerPermissions(): Promise<ReadonlySet<PermissionKey>> {
  const rows = await prisma.permission.findMany({ select: { key: true } });
  return new Set(rows.map((row) => row.key as PermissionKey));
}

const actor = (fixture: Fixture, holder: ReadonlySet<PermissionKey>) => ({
  companyId: fixture.companyId,
  userId: fixture.userId,
  actorEmail: fixture.email,
  holder,
});

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const companyId of createdCompanies) {
    await purgeTestCompany(companyId).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("nobody can build a role stronger than themselves", () => {
  it("refuses a permission the person does not hold", async () => {
    // The case the whole guard exists for: a manager assembling an owner.
    const fixture = await shop();
    const manager: ReadonlySet<PermissionKey> = new Set([
      "sales.view",
      "sales.create",
    ]);

    await expect(
      createRole({
        ...actor(fixture, manager),
        name: "Quietly An Owner",
        permissions: ["sales.view", "billing.manage", "users.manage"],
      }),
    ).rejects.toBeInstanceOf(RoleError);
  }, 120_000);

  it("names which permissions were refused", async () => {
    const fixture = await shop();
    const manager: ReadonlySet<PermissionKey> = new Set(["sales.view"]);

    await expect(
      createRole({
        ...actor(fixture, manager),
        name: "Overreach",
        permissions: ["sales.view", "billing.manage"],
      }),
    ).rejects.toThrow(/billing\.manage/);
  }, 120_000);

  it("allows delegating downwards", async () => {
    const fixture = await shop();
    const manager: ReadonlySet<PermissionKey> = new Set([
      "sales.view",
      "sales.create",
      "customers.view",
    ]);

    const role = await createRole({
      ...actor(fixture, manager),
      name: "Counter Staff",
      permissions: ["sales.view", "sales.create"],
    });
    expect(role.permissions.sort()).toEqual(["sales.create", "sales.view"]);
  }, 120_000);

  it("applies the same rule when a role is edited", async () => {
    // Otherwise the guard is a formality: build a modest role, then widen it.
    const fixture = await shop();
    const manager: ReadonlySet<PermissionKey> = new Set([
      "sales.view",
      "sales.create",
    ]);

    const role = await createRole({
      ...actor(fixture, manager),
      name: "Counter Staff",
      permissions: ["sales.view"],
    });

    await expect(
      updateRole({
        ...actor(fixture, manager),
        roleId: role.id,
        name: "Counter Staff",
        permissions: ["sales.view", "billing.manage"],
      }),
    ).rejects.toThrow(/billing\.manage/);
  }, 120_000);

  it("offers only what the holder can actually give", async () => {
    // The page shows this rather than letting somebody tick a box that will
    // be refused on save.
    const holder: ReadonlySet<PermissionKey> = new Set([
      "sales.view",
      "sales.create",
    ]);
    const offered = grantableBy(holder);
    expect(offered.sort()).toEqual(["sales.create", "sales.view"]);
    expect(offered).not.toContain("billing.manage");
  }, 60_000);
});

describe("the built-in roles", () => {
  it("are listed alongside the company's own", async () => {
    const fixture = await shop();
    const roles = await listRoles(fixture.companyId);

    expect(roles.some((role) => role.isSystem)).toBe(true);
    expect(roles.some((role) => role.key === "owner")).toBe(true);
  }, 120_000);

  it("appear once each, not once per copy", async () => {
    // The first version of the query asked for the company's roles *or* the
    // shared templates, on the belief that a business assigns from both. It
    // does not: every company is given its own copy of all six at signup, so
    // that listed each built-in role twice and the page showed twelve rows for
    // six roles. Neither test above could see it — "some role is a system
    // role" and "some role is owner" are both true of a duplicate.
    const fixture = await shop();
    const roles = await listRoles(fixture.companyId);

    const keys = roles.map((role) => role.key);
    expect(keys, `duplicated: ${keys.join(", ")}`).toEqual([...new Set(keys)]);
  }, 120_000);

  it("are the company's own rows, never the shared templates", async () => {
    // The reason the duplicate mattered beyond the count: a template belongs
    // to no tenant, and a list of things to assign should not contain rows
    // from outside the business looking at it.
    const fixture = await shop();
    const roles = await listRoles(fixture.companyId);

    const owners = await prisma.role.findMany({
      where: { id: { in: roles.map((role) => role.id) } },
      select: { companyId: true },
    });
    expect(owners.every((row) => row.companyId === fixture.companyId)).toBe(
      true,
    );
  }, 120_000);

  it("cannot be edited, even the company's own copy of one", async () => {
    // Deliberately the company's own seeded role, not the shared template.
    // A template has no companyId and is refused by the scope check, so a
    // test reaching for one passes without ever exercising the isSystem
    // guard — which is exactly what the first version of this did.
    const fixture = await shop();
    const all = await ownerPermissions();
    const system = await prisma.role.findFirstOrThrow({
      where: { companyId: fixture.companyId, isSystem: true },
      select: { id: true },
    });

    await expect(
      updateRole({
        ...actor(fixture, all),
        roleId: system.id,
        name: "Hijacked",
        permissions: ["sales.view"],
      }),
    ).rejects.toBeInstanceOf(RoleError);
  }, 120_000);

  it("cannot be deleted, even the company's own copy of one", async () => {
    // One nobody holds, on purpose. The owner's role has a member, so a test
    // reaching for that is refused by the in-use check and never touches the
    // isSystem guard — a second layer quietly standing in for the first.
    const fixture = await shop();
    const system = await prisma.role.findFirstOrThrow({
      where: {
        companyId: fixture.companyId,
        isSystem: true,
        memberships: { none: {} },
      },
      select: { id: true },
    });

    await expect(
      deleteRole({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.email,
        roleId: system.id,
      }),
    ).rejects.toBeInstanceOf(RoleError);
  }, 120_000);
});

describe("living with a custom role", () => {
  it("refuses a second role of the same name", async () => {
    const fixture = await shop();
    const all = await ownerPermissions();

    await createRole({
      ...actor(fixture, all),
      name: "Stock Clerk",
      permissions: ["inventory.view"],
    });
    await expect(
      createRole({
        ...actor(fixture, all),
        name: "Stock Clerk",
        permissions: ["products.view"],
      }),
    ).rejects.toThrow(/already a role/i);
  }, 120_000);

  it("refuses a role that grants nothing", async () => {
    const fixture = await shop();
    const all = await ownerPermissions();

    await expect(
      createRole({
        ...actor(fixture, all),
        name: "Empty",
        permissions: [],
      }),
    ).rejects.toThrow(/at least one/i);
  }, 120_000);

  it("removes one nobody holds", async () => {
    const fixture = await shop();
    const all = await ownerPermissions();

    const role = await createRole({
      ...actor(fixture, all),
      name: "Temporary",
      permissions: ["sales.view"],
    });
    await deleteRole({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.email,
      roleId: role.id,
    });

    const roles = await listRoles(fixture.companyId);
    expect(roles.some((entry) => entry.id === role.id)).toBe(false);
  }, 120_000);

  it("refuses to remove one somebody is using", async () => {
    // Deciding on somebody's behalf what they should have instead is not a
    // decision this makes quietly.
    const fixture = await shop();
    const all = await ownerPermissions();

    const role = await createRole({
      ...actor(fixture, all),
      name: "In Use",
      permissions: ["sales.view"],
    });
    await prisma.membership.updateMany({
      where: { companyId: fixture.companyId },
      data: { roleId: role.id },
    });

    await expect(
      deleteRole({
        companyId: fixture.companyId,
        userId: fixture.userId,
        actorEmail: fixture.email,
        roleId: role.id,
      }),
    ).rejects.toThrow(/holds? this role/i);
  }, 120_000);
});

describe("one business's roles are its own", () => {
  it("will not edit a role belonging to another company", async () => {
    const [mine, theirs] = await Promise.all([shop(), shop()]);
    const all = await ownerPermissions();

    const role = await createRole({
      ...actor(theirs, all),
      name: "Theirs",
      permissions: ["sales.view"],
    });

    await expect(
      updateRole({
        ...actor(mine, all),
        roleId: role.id,
        name: "Taken Over",
        permissions: ["sales.view"],
      }),
    ).rejects.toThrow(/could not be found/i);
  }, 120_000);

  it("does not list another company's roles", async () => {
    const [mine, theirs] = await Promise.all([shop(), shop()]);
    const all = await ownerPermissions();

    await createRole({
      ...actor(theirs, all),
      name: "Only Theirs",
      permissions: ["sales.view"],
    });

    const roles = await listRoles(mine.companyId);
    expect(roles.some((role) => role.name === "Only Theirs")).toBe(false);
  }, 120_000);
});
