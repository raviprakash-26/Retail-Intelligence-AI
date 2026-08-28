import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CompanyStatus } from "@prisma/client";
import type { RegisterInput } from "@/lib/validation/auth";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Suspending a business stops people working in it.
 *
 * `setCompanyStatus` says what the button is for, in its own words:
 *
 *   > Suspension stops people signing in to it. It does not delete anything,
 *   > and it is reversible by the next administrator who disagrees.
 *
 * It stopped nothing. Three places asked whether a company was reachable and
 * all three asked the narrower question — `status === "CANCELLED"` — so a
 * suspended business's members went on signing in, posting invoices and
 * noticing nothing. The administrator pressed the button, watched the status
 * change and the audit row appear, and the shop carried on trading.
 *
 * These drive the real gate rather than the flag. `getCompanyContext` is what
 * every `assertPermission` in the product is built on, and it reads the session
 * from a cookie — so the cookie jar is stubbed here the way the fiscal-year
 * selector's tests stub it, and a real session is issued into it.
 */

/** The cookie jar the session is issued into and read back from. */
const jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name)! } : undefined,
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

const { registerOwner } = await import("@/server/auth/registration");
const { createSession } = await import("@/server/auth/session");
const { getCompanyContext } = await import("@/server/auth/context");
const { setCompanyStatus } = await import("@/server/admin/admin-service");
const { inviteMember, previewInvitation, acceptInvitation } =
  await import("@/server/company/team-service");
const { ALL_PERMISSION_KEYS, SYSTEM_ROLE } =
  await import("@/lib/rbac/permissions");

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
      businessName: `Suspend ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 25000,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

async function signedInOwner() {
  const email = `susp-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const owner = await registerOwner(registrationInput(email));
  createdCompanies.push(owner.companyId);

  jar.clear();
  await createSession({ userId: owner.userId, companyId: owner.companyId });

  return { ...owner, email };
}

/**
 * Suspends through the administrator's own service rather than by writing the
 * column, so the case exercises the button somebody actually presses.
 *
 * The acting administrator is a real user — this one — because the audit entry
 * carries a foreign key to one, and an id belonging to nobody makes
 * `recordAuditLog` swallow an error the test would otherwise be blind to.
 */
async function suspend(companyId: string, adminId: string, adminEmail: string) {
  await setCompanyStatus({
    companyId,
    status: CompanyStatus.SUSPENDED,
    adminId,
    adminEmail,
    reason: "Payment dispute",
  });
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const id of createdCompanies) await purgeTestCompany(id);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("a suspended business", () => {
  it("has no tenant context, where an active one does", async () => {
    const owner = await signedInOwner();

    // The control. Without it a broken cookie stub would make the case below
    // pass for the wrong reason — there would be no context either way.
    const before = await getCompanyContext();
    expect(before?.company.id).toBe(owner.companyId);

    await suspend(owner.companyId, owner.userId, owner.email);
    // The context is memoised per request. There is no request here, so the
    // module is reloaded to get a fresh one rather than trusting the cache to
    // have expired.
    vi.resetModules();
    const { getCompanyContext: fresh } = await import("@/server/auth/context");

    expect(await fresh()).toBeNull();
  }, 120_000);

  it("is the whole of what every permission check is built on", async () => {
    // Said separately because it is the reason the case above matters. Nothing
    // in the product asks about company status; everything asks
    // `assertPermission`, and `assertPermission` is this context or nothing.
    const owner = await signedInOwner();
    await suspend(owner.companyId, owner.userId, owner.email);
    vi.resetModules();
    const { assertPermission } = await import("@/server/auth/context");

    await expect(assertPermission("sales.create")).rejects.toThrow();
  }, 120_000);

  it("does not appear among the companies to switch to", async () => {
    const owner = await signedInOwner();
    vi.resetModules();
    const listed = await import("@/server/auth/context");
    const first = await listed.getUserCompanies();
    expect(first.some((company) => company.id === owner.companyId)).toBe(true);

    await suspend(owner.companyId, owner.userId, owner.email);
    vi.resetModules();
    const again = await import("@/server/auth/context");
    const second = await again.getUserCompanies();

    expect(second.some((company) => company.id === owner.companyId)).toBe(
      false,
    );
  }, 120_000);

  it("cannot take on a new member", async () => {
    // An invitation into a suspended business is an invitation to nothing: the
    // context the new member would get is refused on their first request. It
    // resolves to nothing rather than to a form that cannot lead anywhere.
    const owner = await signedInOwner();
    const invitee = `inv-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
    createdEmails.push(invitee);

    const role = await prisma.role.findFirstOrThrow({
      where: { companyId: owner.companyId, key: SYSTEM_ROLE.ACCOUNTANT },
      select: { id: true },
    });
    const invitation = await inviteMember({
      companyId: owner.companyId,
      companyName: "Suspend Mart",
      invitedById: owner.userId,
      invitedByEmail: owner.email,
      inviterEmailVerified: true,
      holder: new Set(ALL_PERMISSION_KEYS),
      input: {
        email: invitee,
        fullName: "Anita Rao",
        roleId: role.id,
        branchId: "",
      },
    });

    expect(await previewInvitation(invitation.token)).not.toBeNull();

    await suspend(owner.companyId, owner.userId, owner.email);

    expect(await previewInvitation(invitation.token)).toBeNull();
    await expect(
      acceptInvitation({
        input: {
          token: invitation.token,
          fullName: "Anita Rao",
          password: "MountainRiver42!",
          confirmPassword: "MountainRiver42!",
        },
      }),
    ).rejects.toThrow();
  }, 120_000);
});
