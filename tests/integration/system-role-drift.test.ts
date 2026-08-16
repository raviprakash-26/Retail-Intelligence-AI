import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import { syncCompanySystemRoles } from "../../prisma/seed/permissions";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * A company's built-in roles say what the templates say.
 *
 * Provisioning copies the template's rows at signup, and nothing revisited
 * them. A permission added in a later release reached the templates and
 * stopped there: every company already in existence kept the set it was given
 * the day it signed up.
 *
 * The Owner template is the sharpest case. Its `permissions` is `null`,
 * documented as every permission "including ones added in future releases" —
 * true of the template row the seed maintains, and false of every tenant. An
 * owner who signed up before the data export shipped could not export their
 * own books, and the role they held still read "Full access to every module".
 *
 * Each case below works on a company it registers itself, and damages that
 * company's own copies rather than the shared templates. A first draft
 * modified a template to stand in for "a later release", which is what the
 * defect really looks like — and because templates are global and test files
 * run in parallel, it broke two unrelated suites. A tenant missing what its
 * template holds is the same state by a safer route.
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
      businessName: `Drift ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 100_000,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

async function newCompany(): Promise<string> {
  const email = `drift-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return result.companyId;
}

async function keysOf(roleId: string): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({
    where: { roleId },
    select: { permission: { select: { key: true } } },
  });
  return rows.map((row) => row.permission.key).sort();
}

async function ownerRoles(companyId: string) {
  const mine = await prisma.role.findFirst({
    where: { companyId, isSystem: true, key: "owner" },
    select: { id: true },
  });
  const template = await prisma.role.findFirst({
    where: { companyId: null, isSystem: true, key: "owner" },
    select: { id: true },
  });
  return { mine: mine!, template: template! };
}

beforeAll(async () => {
  await ensurePlatformData();
}, 180_000);

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("built-in roles in a company", () => {
  it("hold exactly what their template holds when freshly provisioned", async () => {
    const companyId = await newCompany();

    const companyRoles = await prisma.role.findMany({
      where: { companyId, isSystem: true },
      select: { id: true, key: true },
    });
    expect(companyRoles.length).toBeGreaterThan(0);

    for (const role of companyRoles) {
      const template = await prisma.role.findFirst({
        where: { companyId: null, isSystem: true, key: role.key },
        select: { id: true },
      });
      expect(template, `no template for ${role.key}`).toBeTruthy();
      expect(await keysOf(role.id)).toEqual(await keysOf(template!.id));
    }
  }, 180_000);

  it("regain what a later release added, which they never used to", async () => {
    const companyId = await newCompany();
    const { mine, template } = await ownerRoles(companyId);

    // A tenant provisioned before a permission existed holds every grant its
    // template holds except that one. Removing three reproduces it exactly,
    // without touching the template every other suite reads.
    const dropped = (await keysOf(mine.id)).slice(0, 3);
    expect(dropped).toHaveLength(3);
    await prisma.rolePermission.deleteMany({
      where: { roleId: mine.id, permission: { key: { in: dropped } } },
    });
    for (const key of dropped) {
      expect(await keysOf(mine.id)).not.toContain(key);
    }

    const result = await syncCompanySystemRoles(prisma, companyId);
    expect(result.granted).toBe(3);
    expect(await keysOf(mine.id)).toEqual(await keysOf(template.id));
  }, 180_000);

  it("lose what a template no longer grants", async () => {
    // The half a cascade cannot do: the permission still exists, it simply no
    // longer belongs to the role. Without this, a permission withdrawn from a
    // built-in role in code would stay with every tenant already holding it.
    const companyId = await newCompany();

    // The Cashier rather than the Owner, because the Owner template holds
    // every permission there is and so has no grant that could be a stray.
    const templateCashier = await prisma.role.findFirst({
      where: { companyId: null, isSystem: true, key: "cashier" },
      select: { id: true },
    });
    const companyCashier = await prisma.role.findFirst({
      where: { companyId, isSystem: true, key: "cashier" },
      select: { id: true },
    });
    expect(templateCashier && companyCashier).toBeTruthy();

    const allowed = await keysOf(templateCashier!.id);
    const forbidden = await prisma.permission.findFirst({
      where: { key: { notIn: allowed } },
      select: { id: true, key: true },
    });
    expect(
      forbidden,
      "the cashier template already holds everything",
    ).toBeTruthy();

    await prisma.rolePermission.create({
      data: { roleId: companyCashier!.id, permissionId: forbidden!.id },
    });
    expect(await keysOf(companyCashier!.id)).toContain(forbidden!.key);

    const result = await syncCompanySystemRoles(prisma, companyId);
    expect(result.revoked).toBe(1);
    expect(await keysOf(companyCashier!.id)).toEqual(allowed);
  }, 180_000);

  it("leaves a company's own custom roles alone", async () => {
    // The sync is only safe because it touches nothing a tenant can edit. A
    // role somebody built is not a copy of anything, and must survive a sync
    // that has no template to compare it against.
    const companyId = await newCompany();
    const permission = await prisma.permission.findFirst({
      select: { id: true, key: true },
    });

    const custom = await prisma.role.create({
      data: {
        companyId,
        key: `drift_probe_${Date.now()}`,
        name: "Drift probe",
        description: "Built by the tenant, not copied from anything.",
        isSystem: false,
        permissions: { create: { permissionId: permission!.id } },
      },
      select: { id: true },
    });

    await syncCompanySystemRoles(prisma, companyId);
    expect(await keysOf(custom.id)).toEqual([permission!.key]);
  }, 180_000);
});
