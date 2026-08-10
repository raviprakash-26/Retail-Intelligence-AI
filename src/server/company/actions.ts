"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  acceptInvitationSchema,
  branchSchema,
  changeMemberRoleSchema,
  companyAccountingSchema,
  companyProfileSchema,
  inviteMemberSchema,
  type AcceptInvitationInput,
  type BranchInput,
  type ChangeMemberRoleInput,
  type CompanyAccountingInput,
  type CompanyProfileInput,
  type InviteMemberInput,
} from "@/lib/validation/company";
import { evaluatePasswordStrength } from "@/lib/auth/password-policy";
import {
  ACTION_ERROR,
  fail,
  ok,
  zodFieldErrors,
  type ActionResult,
} from "@/server/auth/action-result";
import {
  assertPermission,
  getAuthSession,
  getCompanyContext,
} from "@/server/auth/context";
import { createSession, setSessionCompany } from "@/server/auth/session";
import { AUDIT_ACTION, recordAuditLog } from "@/server/audit/audit-log";
import { invitationEmail, sendEmail } from "@/server/email/mailer";
import {
  getRequestContext,
  isSameOrigin,
  rateLimitKey,
} from "@/server/security/request-context";
import { checkRateLimit } from "@/server/security/rate-limit";
import {
  createBranch,
  setBranchActive,
  setPrimaryBranch,
  updateBranch,
} from "./branch-service";
import {
  acceptInvitation,
  changeMemberRole,
  inviteMember,
  revokeInvitation,
  setMemberStatus,
  TeamOperationError,
} from "./team-service";
import {
  updateCompanyAccounting,
  updateCompanyProfile,
} from "./settings-service";

/**
 * Company settings, branch and team actions.
 *
 * Every one begins with `assertPermission`, which returns the tenant context.
 * Returning it rather than a boolean is deliberate: the caller then takes
 * `companyId` from the authorised context and cannot accidentally trust an id
 * that arrived with the request.
 */

const SETTINGS_PATHS = [
  "/app",
  "/app/settings/business",
  "/app/settings/accounting",
  "/app/settings/branches",
  "/app/settings/team",
] as const;

function revalidateSettings(): void {
  for (const path of SETTINGS_PATHS) revalidatePath(path);
}

async function guardOrigin(): Promise<ActionResult<never> | null> {
  const { origin, host } = await getRequestContext();
  if (!isSameOrigin(origin, host)) {
    return fail(
      "This request could not be verified. Please reload and try again.",
      {
        code: ACTION_ERROR.FORBIDDEN,
      },
    );
  }
  return null;
}

/** Converts a service-layer failure into a form-level result. */
function fromTeamError(error: unknown): ActionResult<never> {
  if (error instanceof TeamOperationError) {
    return fail(error.message, {
      code: error.code,
      fieldErrors: error.field ? { [error.field]: error.message } : undefined,
    });
  }
  console.error("Company action failed", error);
  return fail("Something went wrong. Nothing was changed — please try again.", {
    code: ACTION_ERROR.UNEXPECTED,
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function updateBusinessProfileAction(
  input: CompanyProfileInput,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("settings.manage");
  const parsed = companyProfileSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  const request = await getRequestContext();
  try {
    await updateCompanyProfile({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });
    revalidateSettings();
    return ok({ saved: true });
  } catch (error) {
    return fromTeamError(error);
  }
}

export async function updateAccountingSettingsAction(
  input: CompanyAccountingInput,
): Promise<ActionResult<{ saved: true; ignoredFields: string[] }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("settings.manage");
  const parsed = companyAccountingSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  const request = await getRequestContext();
  try {
    const result = await updateCompanyAccounting({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });
    revalidateSettings();
    return ok({
      saved: true,
      ignoredFields: result.ok ? result.ignoredFields : [],
    });
  } catch (error) {
    return fromTeamError(error);
  }
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function createBranchAction(
  input: BranchInput,
): Promise<ActionResult<{ id: string }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("branches.manage");
  const parsed = branchSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const branch = await createBranch({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateSettings();
    return ok(branch);
  } catch (error) {
    return fromTeamError(error);
  }
}

export async function updateBranchAction(
  branchId: string,
  input: BranchInput,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("branches.manage");
  const parsed = branchSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    await updateBranch({
      companyId: context.company.id,
      branchId,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateSettings();
    return ok({ saved: true });
  } catch (error) {
    return fromTeamError(error);
  }
}

export async function setBranchActiveAction(
  branchId: string,
  isActive: boolean,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("branches.manage");
  try {
    await setBranchActive({
      companyId: context.company.id,
      branchId,
      isActive,
      userId: context.user.id,
      actorEmail: context.user.email,
    });
    revalidateSettings();
    return ok({ saved: true });
  } catch (error) {
    return fromTeamError(error);
  }
}

export async function setPrimaryBranchAction(
  branchId: string,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("branches.manage");
  try {
    await setPrimaryBranch({
      companyId: context.company.id,
      branchId,
      userId: context.user.id,
      actorEmail: context.user.email,
    });
    revalidateSettings();
    return ok({ saved: true });
  } catch (error) {
    return fromTeamError(error);
  }
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export async function inviteMemberAction(
  input: InviteMemberInput,
): Promise<ActionResult<{ email: string; existingUser: boolean }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("users.manage");
  const parsed = inviteMemberSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  const request = await getRequestContext();
  try {
    const invitation = await inviteMember({
      companyId: context.company.id,
      companyName: context.company.name,
      invitedById: context.user.id,
      invitedByEmail: context.user.email,
      inviterEmailVerified: Boolean(context.user.emailVerifiedAt),
      input: parsed.data,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });

    await sendEmail(
      invitationEmail({
        to: invitation.email,
        name: invitation.fullName,
        inviterName: context.user.fullName,
        companyName: invitation.companyName,
        roleName: invitation.roleName,
        token: invitation.token,
        hasAccount: invitation.existingUser,
      }),
    );

    revalidateSettings();
    return ok({
      email: invitation.email,
      existingUser: invitation.existingUser,
    });
  } catch (error) {
    return fromTeamError(error);
  }
}

export async function revokeInvitationAction(
  invitationId: string,
): Promise<ActionResult<{ revoked: true }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("users.manage");
  try {
    await revokeInvitation({
      companyId: context.company.id,
      invitationId,
      userId: context.user.id,
      actorEmail: context.user.email,
    });
    revalidateSettings();
    return ok({ revoked: true });
  } catch (error) {
    return fromTeamError(error);
  }
}

export async function changeMemberRoleAction(
  input: ChangeMemberRoleInput,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("users.manage");
  const parsed = changeMemberRoleSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  const request = await getRequestContext();
  try {
    await changeMemberRole({
      companyId: context.company.id,
      membershipId: parsed.data.membershipId,
      roleId: parsed.data.roleId,
      branchId: parsed.data.branchId || null,
      actingUserId: context.user.id,
      actorEmail: context.user.email,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });
    revalidateSettings();
    return ok({ saved: true });
  } catch (error) {
    return fromTeamError(error);
  }
}

export async function setMemberStatusAction(
  membershipId: string,
  status: "ACTIVE" | "SUSPENDED" | "REVOKED",
): Promise<ActionResult<{ saved: true }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const context = await assertPermission("users.manage");
  const request = await getRequestContext();
  try {
    await setMemberStatus({
      companyId: context.company.id,
      membershipId,
      status,
      actingUserId: context.user.id,
      actorEmail: context.user.email,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });
    revalidateSettings();
    return ok({ saved: true });
  } catch (error) {
    return fromTeamError(error);
  }
}

// ---------------------------------------------------------------------------
// Invitation acceptance (unauthenticated)
// ---------------------------------------------------------------------------

export async function acceptInvitationAction(
  input: AcceptInvitationInput,
): Promise<ActionResult<{ redirectTo: string }>> {
  const originError = await guardOrigin();
  if (originError) return originError;

  const parsed = acceptInvitationSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  const request = await getRequestContext();

  // Unauthenticated and account-creating, so it carries the same IP budget as
  // registration.
  const limit = await checkRateLimit(
    "REGISTER_IP",
    rateLimitKey(request.ipAddress),
  );
  if (!limit.allowed) {
    return fail(
      "Too many attempts from this connection. Please try again later.",
      {
        code: ACTION_ERROR.RATE_LIMITED,
        retryAfterSeconds: limit.retryAfterSeconds,
      },
    );
  }

  const strength = evaluatePasswordStrength(parsed.data.password, {
    name: parsed.data.fullName,
  });
  if (!strength.acceptable) {
    return fail("Please choose a stronger password.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: {
        password: strength.issues[0] ?? "This password is not acceptable.",
      },
    });
  }

  try {
    const result = await acceptInvitation({
      input: parsed.data,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });

    await createSession({
      userId: result.userId,
      companyId: result.companyId,
      rememberMe: true,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });

    return ok({ redirectTo: "/app" });
  } catch (error) {
    return fromTeamError(error);
  }
}

// ---------------------------------------------------------------------------
// Business switching
// ---------------------------------------------------------------------------

/**
 * Points the current session at another business.
 *
 * The membership lookup is the authorisation: passing an arbitrary companyId
 * finds no membership and is rejected, so this cannot be used to reach a tenant
 * the user does not belong to.
 */
export async function switchCompanyAction(companyId: string): Promise<never> {
  const session = await getAuthSession();
  if (!session) redirect("/login");

  const membership = await prisma.membership.findFirst({
    where: {
      userId: session.user.id,
      companyId,
      status: "ACTIVE",
      company: { status: { not: "CANCELLED" } },
    },
    select: { companyId: true },
  });

  if (!membership) {
    // Deliberately indistinguishable from "no such company": confirming that a
    // company exists but is not theirs is information they should not have.
    redirect("/app");
  }

  await setSessionCompany(session.id, membership.companyId);
  await prisma.user.update({
    where: { id: session.user.id },
    data: { defaultCompanyId: membership.companyId },
  });

  const request = await getRequestContext();
  await recordAuditLog({
    action: AUDIT_ACTION.COMPANY_SWITCHED,
    module: "Auth",
    companyId: membership.companyId,
    userId: session.user.id,
    actorEmail: session.user.email,
    ipAddress: request.ipAddress,
    userAgent: request.userAgent,
  });

  revalidatePath("/app");
  redirect("/app");
}

/** Current tenant context for a client component. Null when signed out. */
export async function getCurrentCompanySummary() {
  const context = await getCompanyContext();
  if (!context) return null;
  return {
    id: context.company.id,
    name: context.company.name,
    roleName: context.membership.roleName,
  };
}
