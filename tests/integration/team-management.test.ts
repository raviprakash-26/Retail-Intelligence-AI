import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_ROLE } from "@/lib/rbac/permissions";
import { hashToken } from "@/lib/auth/tokens";
import { registerOwner } from "@/server/auth/registration";
import type { RegisterInput } from "@/lib/validation/auth";
import {
  acceptInvitation,
  changeMemberRole,
  inviteMember,
  listPendingInvitations,
  listTeamMembers,
  previewInvitation,
  revokeInvitation,
  setMemberStatus,
  TeamOperationError,
} from "@/server/company/team-service";
import { resetAllRateLimitsForTests } from "@/server/security/rate-limit";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Team management against a real database.
 *
 * The guards under test are the ones that stop a business locking itself out
 * or quietly escalating privileges — the failure modes that are catastrophic
 * and silent rather than merely annoying.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function newEmail(prefix: string): string {
  const email = `${prefix}-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  return email;
}

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
      businessName: "Team Test Mart",
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "UNREGISTERED",
      gstin: "",
      pan: "",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 0,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

type Fixture = {
  companyId: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerMembershipId: string;
  roles: Map<string, string>;
};

async function createCompanyFixture(): Promise<Fixture> {
  const ownerEmail = newEmail("owner");
  const result = await registerOwner(registrationInput(ownerEmail));
  createdCompanies.push(result.companyId);

  // Registration leaves the owner unverified; inviting requires verification,
  // so the fixture confirms it the way clicking the email link would.
  await prisma.user.update({
    where: { id: result.userId },
    data: { emailVerifiedAt: new Date(), status: "ACTIVE" },
  });

  const roles = await prisma.role.findMany({
    where: { companyId: result.companyId },
    select: { id: true, key: true },
  });

  const ownerMembership = await prisma.membership.findFirstOrThrow({
    where: { userId: result.userId, companyId: result.companyId },
    select: { id: true },
  });

  return {
    companyId: result.companyId,
    ownerUserId: result.userId,
    ownerEmail,
    ownerMembershipId: ownerMembership.id,
    roles: new Map(roles.map((role) => [role.key, role.id])),
  };
}

async function invite(fixture: Fixture, roleKey: string, email: string) {
  return inviteMember({
    companyId: fixture.companyId,
    companyName: "Team Test Mart",
    invitedById: fixture.ownerUserId,
    invitedByEmail: fixture.ownerEmail,
    inviterEmailVerified: true,
    input: {
      email,
      fullName: "Deepa Iyer",
      roleId: fixture.roles.get(roleKey)!,
      branchId: "",
    },
  });
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

beforeEach(() => {
  resetAllRateLimitsForTests();
});

afterAll(async () => {
  for (const companyId of createdCompanies) {
    await purgeTestCompany(companyId).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("invitations", () => {
  it("issues an invitation whose token is stored only as a hash", async () => {
    const fixture = await createCompanyFixture();
    const email = newEmail("invitee");

    const invitation = await invite(fixture, SYSTEM_ROLE.ACCOUNTANT, email);
    expect(invitation.existingUser).toBe(false);

    const record = await prisma.verificationToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(invitation.token) },
      select: {
        purpose: true,
        companyId: true,
        tokenHash: true,
        metadata: true,
      },
    });

    expect(record.purpose).toBe("MEMBER_INVITATION");
    expect(record.companyId).toBe(fixture.companyId);
    expect(record.tokenHash).not.toBe(invitation.token);
    // The role is fixed at invitation time so the invitee cannot pick their own.
    expect((record.metadata as { roleId?: string }).roleId).toBe(
      fixture.roles.get(SYSTEM_ROLE.ACCOUNTANT),
    );
  }, 60_000);

  it("refuses to invite when the inviter's own email is unverified", async () => {
    const fixture = await createCompanyFixture();

    await expect(
      inviteMember({
        companyId: fixture.companyId,
        companyName: "Team Test Mart",
        invitedById: fixture.ownerUserId,
        invitedByEmail: fixture.ownerEmail,
        inviterEmailVerified: false,
        input: {
          email: newEmail("blocked"),
          fullName: "Someone",
          roleId: fixture.roles.get(SYSTEM_ROLE.CASHIER)!,
          branchId: "",
        },
      }),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  }, 60_000);

  it("supersedes an earlier invitation to the same address", async () => {
    const fixture = await createCompanyFixture();
    const email = newEmail("resent");

    const first = await invite(fixture, SYSTEM_ROLE.CASHIER, email);
    const second = await invite(fixture, SYSTEM_ROLE.ACCOUNTANT, email);

    // The forwarded older email must stop working, so a stale role cannot be
    // used to join.
    expect(await previewInvitation(first.token)).toBeNull();
    expect(await previewInvitation(second.token)).not.toBeNull();

    const pending = await listPendingInvitations(fixture.companyId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.roleName).toBe("Accountant");
  }, 60_000);

  it("refuses to invite someone already on the team", async () => {
    const fixture = await createCompanyFixture();

    await expect(
      invite(fixture, SYSTEM_ROLE.MANAGER, fixture.ownerEmail),
    ).rejects.toMatchObject({ code: "ALREADY_MEMBER" });
  }, 60_000);

  it("refuses a role belonging to another company", async () => {
    const [fixture, other] = await Promise.all([
      createCompanyFixture(),
      createCompanyFixture(),
    ]);

    await expect(
      inviteMember({
        companyId: fixture.companyId,
        companyName: "Team Test Mart",
        invitedById: fixture.ownerUserId,
        invitedByEmail: fixture.ownerEmail,
        inviterEmailVerified: true,
        input: {
          email: newEmail("crosstenant"),
          fullName: "Someone",
          // A real role id, but belonging to a different tenant.
          roleId: other.roles.get(SYSTEM_ROLE.OWNER)!,
          branchId: "",
        },
      }),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  }, 90_000);

  it("stops a withdrawn invitation from being used", async () => {
    const fixture = await createCompanyFixture();
    const email = newEmail("withdrawn");
    const invitation = await invite(fixture, SYSTEM_ROLE.CASHIER, email);

    const pending = await listPendingInvitations(fixture.companyId);
    await revokeInvitation({
      companyId: fixture.companyId,
      invitationId: pending[0]!.id,
      userId: fixture.ownerUserId,
      actorEmail: fixture.ownerEmail,
    });

    expect(await previewInvitation(invitation.token)).toBeNull();
    await expect(
      acceptInvitation({
        input: {
          token: invitation.token,
          fullName: "Deepa Iyer",
          mobile: "",
          password: "MountainRiver42!",
          confirmPassword: "MountainRiver42!",
        },
      }),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  }, 60_000);

  it("rejects an expired invitation", async () => {
    const fixture = await createCompanyFixture();
    const invitation = await invite(
      fixture,
      SYSTEM_ROLE.CASHIER,
      newEmail("expired"),
    );

    await prisma.verificationToken.updateMany({
      where: { tokenHash: hashToken(invitation.token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await previewInvitation(invitation.token)).toBeNull();
  }, 60_000);
});

describe("accepting an invitation", () => {
  it("creates the account, the membership and marks the email verified", async () => {
    const fixture = await createCompanyFixture();
    const email = newEmail("newjoiner");
    const invitation = await invite(fixture, SYSTEM_ROLE.ACCOUNTANT, email);

    const result = await acceptInvitation({
      input: {
        token: invitation.token,
        fullName: "Deepa Iyer",
        mobile: "9845099999",
        password: "MountainRiver42!",
        confirmPassword: "MountainRiver42!",
      },
    });

    expect(result.isNewUser).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: { email: true, status: true, emailVerifiedAt: true },
    });

    expect(user.email).toBe(email);
    expect(user.status).toBe("ACTIVE");
    // Following the link proves control of the mailbox, so a separate
    // verification email would be asking for what has already been shown.
    expect(user.emailVerifiedAt).not.toBeNull();

    const members = await listTeamMembers(fixture.companyId);
    const joined = members.find((member) => member.email === email);
    expect(joined?.roleKey).toBe(SYSTEM_ROLE.ACCOUNTANT);
    expect(joined?.status).toBe("ACTIVE");
  }, 60_000);

  it("attaches a second business to an existing account without changing its password", async () => {
    const [first, second] = await Promise.all([
      createCompanyFixture(),
      createCompanyFixture(),
    ]);

    const before = await prisma.user.findUniqueOrThrow({
      where: { id: first.ownerUserId },
      select: { passwordHash: true },
    });

    const invitation = await inviteMember({
      companyId: second.companyId,
      companyName: "Team Test Mart",
      invitedById: second.ownerUserId,
      invitedByEmail: second.ownerEmail,
      inviterEmailVerified: true,
      input: {
        email: first.ownerEmail,
        fullName: "Ravi Prakash",
        roleId: second.roles.get(SYSTEM_ROLE.MANAGER)!,
        branchId: "",
      },
    });

    const result = await acceptInvitation({
      input: {
        token: invitation.token,
        fullName: "Ravi Prakash",
        mobile: "",
        // A different password from their real one; it must be ignored.
        password: "SomeOtherPassword99!",
        confirmPassword: "SomeOtherPassword99!",
      },
    });

    expect(result.isNewUser).toBe(false);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: first.ownerUserId },
      select: { passwordHash: true },
    });
    expect(after.passwordHash).toBe(before.passwordHash);

    // They now hold memberships in both businesses.
    const memberships = await prisma.membership.count({
      where: { userId: first.ownerUserId, status: "ACTIVE" },
    });
    expect(memberships).toBe(2);
  }, 90_000);

  it("cannot be accepted twice", async () => {
    const fixture = await createCompanyFixture();
    const invitation = await invite(
      fixture,
      SYSTEM_ROLE.CASHIER,
      newEmail("once"),
    );

    const payload = {
      token: invitation.token,
      fullName: "Deepa Iyer",
      mobile: "",
      password: "MountainRiver42!",
      confirmPassword: "MountainRiver42!",
    };

    await acceptInvitation({ input: payload });
    await expect(acceptInvitation({ input: payload })).rejects.toBeInstanceOf(
      TeamOperationError,
    );
  }, 60_000);
});

describe("membership guards", () => {
  it("refuses to remove the only owner", async () => {
    const fixture = await createCompanyFixture();

    await expect(
      setMemberStatus({
        companyId: fixture.companyId,
        membershipId: fixture.ownerMembershipId,
        status: "REVOKED",
        // A different acting user, so the self-change guard is not what fires.
        actingUserId: "00000000-0000-0000-0000-000000000000",
        actorEmail: "someone@example.com",
      }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });
  }, 60_000);

  it("refuses to demote the only owner", async () => {
    const fixture = await createCompanyFixture();

    await expect(
      changeMemberRole({
        companyId: fixture.companyId,
        membershipId: fixture.ownerMembershipId,
        roleId: fixture.roles.get(SYSTEM_ROLE.CASHIER)!,
        actingUserId: "00000000-0000-0000-0000-000000000000",
        actorEmail: "someone@example.com",
      }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });
  }, 60_000);

  it("allows demoting an owner once a second owner exists", async () => {
    const fixture = await createCompanyFixture();
    const secondOwnerEmail = newEmail("owner2");

    const invitation = await invite(
      fixture,
      SYSTEM_ROLE.OWNER,
      secondOwnerEmail,
    );
    const joined = await acceptInvitation({
      input: {
        token: invitation.token,
        fullName: "Second Owner",
        mobile: "",
        password: "MountainRiver42!",
        confirmPassword: "MountainRiver42!",
      },
    });

    await expect(
      changeMemberRole({
        companyId: fixture.companyId,
        membershipId: fixture.ownerMembershipId,
        roleId: fixture.roles.get(SYSTEM_ROLE.MANAGER)!,
        actingUserId: joined.userId,
        actorEmail: secondOwnerEmail,
      }),
    ).resolves.toBeUndefined();

    const members = await listTeamMembers(fixture.companyId);
    const demoted = members.find(
      (member) => member.email === fixture.ownerEmail,
    );
    expect(demoted?.roleKey).toBe(SYSTEM_ROLE.MANAGER);
  }, 90_000);

  it("refuses to let anyone change their own role", async () => {
    const fixture = await createCompanyFixture();
    const email = newEmail("selfpromote");
    const invitation = await invite(fixture, SYSTEM_ROLE.CASHIER, email);
    const joined = await acceptInvitation({
      input: {
        token: invitation.token,
        fullName: "Cashier",
        mobile: "",
        password: "MountainRiver42!",
        confirmPassword: "MountainRiver42!",
      },
    });

    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: joined.userId, companyId: fixture.companyId },
      select: { id: true },
    });

    // Self-promotion is the obvious escalation path for anyone who holds
    // users.manage, so it is simply not possible.
    await expect(
      changeMemberRole({
        companyId: fixture.companyId,
        membershipId: membership.id,
        roleId: fixture.roles.get(SYSTEM_ROLE.OWNER)!,
        actingUserId: joined.userId,
        actorEmail: email,
      }),
    ).rejects.toMatchObject({ code: "SELF_ROLE_CHANGE" });
  }, 90_000);

  it("refuses to let anyone suspend themselves", async () => {
    const fixture = await createCompanyFixture();

    await expect(
      setMemberStatus({
        companyId: fixture.companyId,
        membershipId: fixture.ownerMembershipId,
        status: "SUSPENDED",
        actingUserId: fixture.ownerUserId,
        actorEmail: fixture.ownerEmail,
      }),
    ).rejects.toMatchObject({ code: "SELF_STATUS_CHANGE" });
  }, 60_000);

  it("ends every session when a member is suspended", async () => {
    const fixture = await createCompanyFixture();
    const email = newEmail("suspendme");
    const invitation = await invite(fixture, SYSTEM_ROLE.CASHIER, email);
    const joined = await acceptInvitation({
      input: {
        token: invitation.token,
        fullName: "Cashier",
        mobile: "",
        password: "MountainRiver42!",
        confirmPassword: "MountainRiver42!",
      },
    });

    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: joined.userId, companyId: fixture.companyId },
      select: { id: true },
    });

    const epochBefore = await prisma.user.findUniqueOrThrow({
      where: { id: joined.userId },
      select: { sessionEpoch: true },
    });

    await setMemberStatus({
      companyId: fixture.companyId,
      membershipId: membership.id,
      status: "SUSPENDED",
      actingUserId: fixture.ownerUserId,
      actorEmail: fixture.ownerEmail,
    });

    // A bumped epoch retires every session issued before it — removing access
    // has to mean now, not at session expiry.
    const epochAfter = await prisma.user.findUniqueOrThrow({
      where: { id: joined.userId },
      select: { sessionEpoch: true },
    });
    expect(epochAfter.sessionEpoch).toBeGreaterThan(epochBefore.sessionEpoch);
  }, 90_000);

  it("refuses to act on a membership belonging to another company", async () => {
    const [fixture, other] = await Promise.all([
      createCompanyFixture(),
      createCompanyFixture(),
    ]);

    await expect(
      setMemberStatus({
        companyId: fixture.companyId,
        membershipId: other.ownerMembershipId,
        status: "SUSPENDED",
        actingUserId: fixture.ownerUserId,
        actorEmail: fixture.ownerEmail,
      }),
    ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  }, 90_000);
});
