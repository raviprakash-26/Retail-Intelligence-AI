import "server-only";
import { MembershipStatus, UserStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { expiresAt, hashToken, issueToken, TOKEN_TTL } from "@/lib/auth/tokens";
import { SYSTEM_ROLE } from "@/lib/rbac/permissions";
import type {
  AcceptInvitationInput,
  InviteMemberInput,
} from "@/lib/validation/company";
import { recordAuditLog } from "@/server/audit/audit-log";
import { revokeAllSessions } from "@/server/auth/session";

/**
 * Team membership and invitations.
 *
 * The rules that make this safe are all about not being able to lock a
 * business out of itself, and not being able to quietly escalate:
 *
 *   • A company must always retain at least one active Owner. The last one
 *     cannot be removed, suspended or demoted — by anyone, including
 *     themselves.
 *   • You cannot change your own role. Otherwise "grant myself Owner" is one
 *     request away for anyone holding `users.manage`.
 *   • Only a verified email may invite. An unverified inviter could otherwise
 *     hand out access to a business they have not proven they control.
 *   • Revoking someone ends their sessions immediately, not at expiry.
 */

export const TEAM_AUDIT = {
  MEMBER_INVITED: "team.member_invited",
  INVITATION_REVOKED: "team.invitation_revoked",
  INVITATION_ACCEPTED: "team.invitation_accepted",
  MEMBER_ROLE_CHANGED: "team.member_role_changed",
  MEMBER_SUSPENDED: "team.member_suspended",
  MEMBER_REACTIVATED: "team.member_reactivated",
  MEMBER_REMOVED: "team.member_removed",
} as const;

export class TeamOperationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "TeamOperationError";
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type TeamMember = {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  status: MembershipStatus;
  roleId: string;
  roleKey: string;
  roleName: string;
  branchId: string | null;
  branchName: string | null;
  emailVerified: boolean;
  lastLoginAt: Date | null;
  joinedAt: Date | null;
  isOwner: boolean;
};

export async function listTeamMembers(
  companyId: string,
): Promise<TeamMember[]> {
  const memberships = await prisma.membership.findMany({
    where: { companyId, status: { not: MembershipStatus.REVOKED } },
    select: {
      id: true,
      status: true,
      roleId: true,
      branchId: true,
      joinedAt: true,
      role: { select: { key: true, name: true } },
      branch: { select: { name: true } },
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          emailVerifiedAt: true,
          lastLoginAt: true,
        },
      },
    },
    orderBy: [{ createdAt: "asc" }],
  });

  return memberships.map((membership) => ({
    membershipId: membership.id,
    userId: membership.user.id,
    fullName: membership.user.fullName,
    email: membership.user.email,
    status: membership.status,
    roleId: membership.roleId,
    roleKey: membership.role.key,
    roleName: membership.role.name,
    branchId: membership.branchId,
    branchName: membership.branch?.name ?? null,
    emailVerified: Boolean(membership.user.emailVerifiedAt),
    lastLoginAt: membership.user.lastLoginAt,
    joinedAt: membership.joinedAt,
    isOwner: membership.role.key === SYSTEM_ROLE.OWNER,
  }));
}

export type PendingInvitation = {
  id: string;
  email: string;
  fullName: string;
  roleName: string;
  invitedAt: Date;
  expiresAt: Date;
  expired: boolean;
};

export async function listPendingInvitations(
  companyId: string,
): Promise<PendingInvitation[]> {
  const tokens = await prisma.verificationToken.findMany({
    where: {
      companyId,
      purpose: "MEMBER_INVITATION",
      consumedAt: null,
    },
    select: {
      id: true,
      email: true,
      metadata: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const now = Date.now();
  return tokens.map((token) => {
    const metadata = (token.metadata ?? {}) as {
      fullName?: string;
      roleName?: string;
    };
    return {
      id: token.id,
      email: token.email,
      fullName: metadata.fullName ?? token.email,
      roleName: metadata.roleName ?? "Member",
      invitedAt: token.createdAt,
      expiresAt: token.expiresAt,
      expired: token.expiresAt.getTime() <= now,
    };
  });
}

export async function listAssignableRoles(companyId: string) {
  return prisma.role.findMany({
    where: { companyId },
    select: { id: true, key: true, name: true, description: true },
    orderBy: { name: "asc" },
  });
}

/** Active owners, used by every guard that protects the last one. */
async function countActiveOwners(companyId: string): Promise<number> {
  return prisma.membership.count({
    where: {
      companyId,
      status: MembershipStatus.ACTIVE,
      role: { key: SYSTEM_ROLE.OWNER },
    },
  });
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export type InvitationIssued = {
  token: string;
  email: string;
  fullName: string;
  roleName: string;
  companyName: string;
  /** True when the invitee already has an account and only needs to accept. */
  existingUser: boolean;
};

export async function inviteMember(params: {
  companyId: string;
  companyName: string;
  invitedById: string;
  invitedByEmail: string;
  inviterEmailVerified: boolean;
  input: InviteMemberInput;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<InvitationIssued> {
  const { companyId, input } = params;

  if (!params.inviterEmailVerified) {
    throw new TeamOperationError(
      "Confirm your own email address before inviting others.",
      "EMAIL_NOT_VERIFIED",
    );
  }

  const role = await prisma.role.findFirst({
    where: { id: input.roleId, companyId },
    select: { id: true, name: true },
  });
  if (!role) {
    throw new TeamOperationError(
      "That role does not exist.",
      "ROLE_NOT_FOUND",
      "roleId",
    );
  }

  if (input.branchId) {
    const branch = await prisma.branch.findFirst({
      where: { id: input.branchId, companyId },
      select: { id: true },
    });
    if (!branch) {
      throw new TeamOperationError(
        "That branch does not exist.",
        "BRANCH_NOT_FOUND",
        "branchId",
      );
    }
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (existingUser) {
    const membership = await prisma.membership.findUnique({
      where: { userId_companyId: { userId: existingUser.id, companyId } },
      select: { status: true },
    });
    if (membership && membership.status !== MembershipStatus.REVOKED) {
      throw new TeamOperationError(
        "That person is already on your team.",
        "ALREADY_MEMBER",
        "email",
      );
    }
  }

  const { token, tokenHash } = issueToken();

  await prisma.$transaction(async (tx) => {
    // Re-inviting supersedes any outstanding invitation for the same address,
    // so a forwarded older email cannot be used to join with a stale role.
    await tx.verificationToken.updateMany({
      where: {
        companyId,
        email: input.email,
        purpose: "MEMBER_INVITATION",
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    await tx.verificationToken.create({
      data: {
        tokenHash,
        purpose: "MEMBER_INVITATION",
        email: input.email,
        companyId,
        // The role is fixed at invitation time and read back on acceptance, so
        // the invitee cannot choose their own.
        metadata: {
          fullName: input.fullName,
          roleId: role.id,
          roleName: role.name,
          branchId: input.branchId || null,
          invitedById: params.invitedById,
        },
        expiresAt: expiresAt(TOKEN_TTL.MEMBER_INVITATION_MS),
      },
    });
  });

  await recordAuditLog({
    action: TEAM_AUDIT.MEMBER_INVITED,
    module: "Team",
    companyId,
    userId: params.invitedById,
    actorEmail: params.invitedByEmail,
    entityType: "Invitation",
    metadata: { email: input.email, roleName: role.name },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return {
    token,
    email: input.email,
    fullName: input.fullName,
    roleName: role.name,
    companyName: params.companyName,
    existingUser: Boolean(existingUser),
  };
}

export async function revokeInvitation(params: {
  companyId: string;
  invitationId: string;
  userId: string;
  actorEmail: string;
}): Promise<void> {
  const result = await prisma.verificationToken.updateMany({
    where: {
      id: params.invitationId,
      companyId: params.companyId,
      purpose: "MEMBER_INVITATION",
      consumedAt: null,
    },
    data: { consumedAt: new Date() },
  });

  if (result.count === 0) {
    throw new TeamOperationError(
      "That invitation has already been used or withdrawn.",
      "INVITATION_NOT_FOUND",
    );
  }

  await recordAuditLog({
    action: TEAM_AUDIT.INVITATION_REVOKED,
    module: "Team",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Invitation",
    entityId: params.invitationId,
  });
}

export type InvitationPreview = {
  email: string;
  fullName: string;
  roleName: string;
  companyName: string;
  /** Whether the invitee already has an account, which changes the form. */
  hasAccount: boolean;
};

/** Resolves an invitation token for display, without consuming it. */
export async function previewInvitation(
  token: string,
): Promise<InvitationPreview | null> {
  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      email: true,
      purpose: true,
      consumedAt: true,
      expiresAt: true,
      metadata: true,
      company: { select: { name: true, status: true } },
    },
  });

  if (
    !record ||
    record.purpose !== "MEMBER_INVITATION" ||
    record.consumedAt ||
    record.expiresAt.getTime() <= Date.now() ||
    !record.company ||
    record.company.status === "CANCELLED"
  ) {
    return null;
  }

  const metadata = (record.metadata ?? {}) as {
    fullName?: string;
    roleName?: string;
  };

  const user = await prisma.user.findUnique({
    where: { email: record.email },
    select: { id: true },
  });

  return {
    email: record.email,
    fullName: metadata.fullName ?? "",
    roleName: metadata.roleName ?? "Member",
    companyName: record.company.name,
    hasAccount: Boolean(user),
  };
}

export type AcceptedInvitation = {
  userId: string;
  companyId: string;
  isNewUser: boolean;
};

/**
 * Accepts an invitation.
 *
 * Creates the account when the invitee is new, or attaches a membership when
 * they already have one. Accepting proves control of the invited mailbox, so
 * the address is marked verified — that is exactly what a verification email
 * would have established.
 */
export async function acceptInvitation(params: {
  input: AcceptInvitationInput;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<AcceptedInvitation> {
  const { input } = params;

  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash: hashToken(input.token) },
    select: {
      id: true,
      email: true,
      companyId: true,
      purpose: true,
      consumedAt: true,
      expiresAt: true,
      metadata: true,
    },
  });

  if (
    !record ||
    record.purpose !== "MEMBER_INVITATION" ||
    record.consumedAt ||
    record.expiresAt.getTime() <= Date.now() ||
    !record.companyId
  ) {
    throw new TeamOperationError(
      "This invitation is no longer valid. Ask for a new one.",
      "INVITATION_INVALID",
    );
  }

  const metadata = (record.metadata ?? {}) as {
    roleId?: string;
    branchId?: string | null;
  };

  if (!metadata.roleId) {
    throw new TeamOperationError(
      "This invitation is missing its role and cannot be accepted.",
      "INVITATION_INVALID",
    );
  }

  const companyId = record.companyId;
  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // Consume by id *and* unconsumed state so two parallel submissions of the
    // same link cannot both create a membership.
    const consumed = await tx.verificationToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count === 0) {
      throw new TeamOperationError(
        "This invitation has already been accepted.",
        "INVITATION_INVALID",
      );
    }

    const existing = await tx.user.findUnique({
      where: { email: record.email },
      select: { id: true, status: true },
    });

    let userId: string;
    let isNewUser = false;

    if (existing) {
      userId = existing.id;
      // An existing user keeps their password; the one they typed is ignored
      // rather than silently overwriting a credential they already rely on.
      await tx.user.update({
        where: { id: userId },
        data: {
          emailVerifiedAt: now,
          lastLoginAt: now,
          status:
            existing.status === UserStatus.PENDING_VERIFICATION
              ? UserStatus.ACTIVE
              : existing.status,
        },
      });
    } else {
      isNewUser = true;
      const created = await tx.user.create({
        data: {
          email: record.email,
          fullName: input.fullName,
          mobile: input.mobile || null,
          passwordHash,
          // Following the link proves control of the mailbox.
          emailVerifiedAt: now,
          // Accepting signs them straight in; this is a real sign-in.
          lastLoginAt: now,
          status: UserStatus.ACTIVE,
          defaultCompanyId: companyId,
        },
        select: { id: true },
      });
      userId = created.id;
    }

    await tx.membership.upsert({
      where: { userId_companyId: { userId, companyId } },
      create: {
        userId,
        companyId,
        roleId: metadata.roleId!,
        branchId: metadata.branchId || null,
        status: MembershipStatus.ACTIVE,
        joinedAt: now,
      },
      update: {
        roleId: metadata.roleId!,
        branchId: metadata.branchId || null,
        status: MembershipStatus.ACTIVE,
        joinedAt: now,
      },
    });

    await recordAuditLog(
      {
        action: TEAM_AUDIT.INVITATION_ACCEPTED,
        module: "Team",
        companyId,
        userId,
        actorEmail: record.email,
        entityType: "Membership",
        metadata: { isNewUser },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx,
    );

    return { userId, companyId, isNewUser };
  });

  return result;
}

// ---------------------------------------------------------------------------
// Membership changes
// ---------------------------------------------------------------------------

async function loadMembership(companyId: string, membershipId: string) {
  const membership = await prisma.membership.findFirst({
    where: { id: membershipId, companyId },
    select: {
      id: true,
      userId: true,
      status: true,
      role: { select: { key: true, name: true } },
      user: { select: { email: true, fullName: true } },
    },
  });

  if (!membership) {
    throw new TeamOperationError(
      "That team member could not be found.",
      "MEMBER_NOT_FOUND",
    );
  }
  return membership;
}

/**
 * Blocks any change that would remove the company's last active owner.
 * `losingOwner` is true when the operation ends this membership's ownership.
 */
async function assertNotLastOwner(
  companyId: string,
  membership: { status: MembershipStatus; role: { key: string } },
  losingOwner: boolean,
): Promise<void> {
  if (!losingOwner) return;
  if (membership.role.key !== SYSTEM_ROLE.OWNER) return;
  if (membership.status !== MembershipStatus.ACTIVE) return;

  const owners = await countActiveOwners(companyId);
  if (owners <= 1) {
    throw new TeamOperationError(
      "This is the only Owner. Promote someone else to Owner first, otherwise nobody could manage the business.",
      "LAST_OWNER",
    );
  }
}

export async function changeMemberRole(params: {
  companyId: string;
  membershipId: string;
  roleId: string;
  branchId?: string | null;
  actingUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const membership = await loadMembership(
    params.companyId,
    params.membershipId,
  );

  // Self-promotion is the obvious escalation path for anyone holding
  // `users.manage`, so changing your own role is simply not possible.
  if (membership.userId === params.actingUserId) {
    throw new TeamOperationError(
      "You cannot change your own role. Ask another Owner to do it.",
      "SELF_ROLE_CHANGE",
    );
  }

  const role = await prisma.role.findFirst({
    where: { id: params.roleId, companyId: params.companyId },
    select: { id: true, key: true, name: true },
  });
  if (!role) {
    throw new TeamOperationError(
      "That role does not exist.",
      "ROLE_NOT_FOUND",
      "roleId",
    );
  }

  await assertNotLastOwner(
    params.companyId,
    membership,
    role.key !== SYSTEM_ROLE.OWNER,
  );

  if (params.branchId) {
    const branch = await prisma.branch.findFirst({
      where: { id: params.branchId, companyId: params.companyId },
      select: { id: true },
    });
    if (!branch) {
      throw new TeamOperationError(
        "That branch does not exist.",
        "BRANCH_NOT_FOUND",
        "branchId",
      );
    }
  }

  await prisma.membership.update({
    where: { id: membership.id },
    data: { roleId: role.id, branchId: params.branchId || null },
  });

  // The member's permissions have changed. Ending their sessions forces the
  // new role to take effect on their next request rather than whenever their
  // cached context happens to expire.
  await revokeAllSessions(membership.userId);

  await recordAuditLog({
    action: TEAM_AUDIT.MEMBER_ROLE_CHANGED,
    module: "Team",
    companyId: params.companyId,
    userId: params.actingUserId,
    actorEmail: params.actorEmail,
    entityType: "Membership",
    entityId: membership.id,
    metadata: {
      member: membership.user.email,
      from: membership.role.name,
      to: role.name,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}

export async function setMemberStatus(params: {
  companyId: string;
  membershipId: string;
  status: Extract<MembershipStatus, "ACTIVE" | "SUSPENDED" | "REVOKED">;
  actingUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const membership = await loadMembership(
    params.companyId,
    params.membershipId,
  );

  if (membership.userId === params.actingUserId) {
    throw new TeamOperationError(
      "You cannot change your own access. Ask another Owner to do it.",
      "SELF_STATUS_CHANGE",
    );
  }

  const losingAccess = params.status !== MembershipStatus.ACTIVE;
  await assertNotLastOwner(params.companyId, membership, losingAccess);

  await prisma.membership.update({
    where: { id: membership.id },
    data: { status: params.status },
  });

  if (losingAccess) {
    // Immediate, not at session expiry. Removing someone has to mean now.
    await revokeAllSessions(membership.userId);
  }

  const action =
    params.status === MembershipStatus.ACTIVE
      ? TEAM_AUDIT.MEMBER_REACTIVATED
      : params.status === MembershipStatus.SUSPENDED
        ? TEAM_AUDIT.MEMBER_SUSPENDED
        : TEAM_AUDIT.MEMBER_REMOVED;

  await recordAuditLog({
    action,
    module: "Team",
    companyId: params.companyId,
    userId: params.actingUserId,
    actorEmail: params.actorEmail,
    entityType: "Membership",
    entityId: membership.id,
    metadata: { member: membership.user.email, status: params.status },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}
