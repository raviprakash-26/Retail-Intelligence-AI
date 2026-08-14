"use server";

import { redirect } from "next/navigation";
import { UserStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  fakeVerifyPassword,
  hashPassword,
  verifyPassword,
} from "@/lib/auth/password";
import { evaluatePasswordStrength } from "@/lib/auth/password-policy";
import { expiresAt, hashToken, issueToken, TOKEN_TTL } from "@/lib/auth/tokens";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  type LoginInput,
  type RegisterInput,
} from "@/lib/validation/auth";
import { AUDIT_ACTION, recordAuditLog } from "@/server/audit/audit-log";
import {
  passwordResetEmail,
  passwordResetUnknownAccountEmail,
  sendEmail,
  verificationEmail,
} from "@/server/email/mailer";
import { checkRateLimit, clearRateLimit } from "@/server/security/rate-limit";
import {
  getRequestContext,
  isSameOrigin,
  rateLimitKey,
} from "@/server/security/request-context";
import {
  ACTION_ERROR,
  fail,
  ok,
  safeRedirectPath,
  zodFieldErrors,
  type ActionResult,
} from "./action-result";
import { EmailAlreadyRegisteredError, registerOwner } from "./registration";
import { getAuthSession } from "./context";
import { createSession, destroySession, revokeAllSessions } from "./session";

/**
 * Authentication server actions.
 *
 * Cross-cutting rules applied here:
 *
 *   • Every action re-validates its input on the server. The browser's
 *     validation is a convenience; this is the decision.
 *   • Credential endpoints are rate limited on two axes — the caller's IP and
 *     the account being targeted — because either alone is trivially evaded.
 *   • Responses do not reveal whether an email is registered. Sign-in and
 *     password reset return the same shape for a real and an unknown account,
 *     and sign-in burns comparable time on both.
 */

/** Repeated failures lock an account for progressively longer. */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_STEPS_MS = [
  1 * 60_000, // 5th failure:  1 minute
  5 * 60_000, // 6th:          5 minutes
  15 * 60_000, // 7th:        15 minutes
  60 * 60_000, // 8th and on:  1 hour
];

function lockoutDuration(failedCount: number): number {
  const index = Math.min(
    Math.max(failedCount - LOCKOUT_THRESHOLD, 0),
    LOCKOUT_STEPS_MS.length - 1,
  );
  return LOCKOUT_STEPS_MS[index] ?? 60 * 60_000;
}

/** Blocks a cross-site POST before it reaches any credential logic. */
async function requireSameOrigin(): Promise<ActionResult<never> | null> {
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

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

export type SignInResult = { redirectTo: string };

export async function signInAction(
  input: LoginInput & { next?: string },
): Promise<ActionResult<SignInResult>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  const { email, password, rememberMe } = parsed.data;
  const context = await getRequestContext();
  const ipKey = rateLimitKey(context.ipAddress);

  const [byIp, byAccount] = await Promise.all([
    checkRateLimit("SIGN_IN_IP", ipKey),
    checkRateLimit("SIGN_IN_ACCOUNT", email),
  ]);

  if (!byIp.allowed || !byAccount.allowed) {
    const retryAfterSeconds = Math.max(
      byIp.allowed ? 0 : byIp.retryAfterSeconds,
      byAccount.allowed ? 0 : byAccount.retryAfterSeconds,
    );
    await recordAuditLog({
      action: AUDIT_ACTION.SIGN_IN_BLOCKED,
      module: "Auth",
      actorEmail: email,
      metadata: { reason: "rate_limited" },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return fail(
      "Too many sign-in attempts. Please wait a few minutes and try again.",
      { code: ACTION_ERROR.RATE_LIMITED, retryAfterSeconds },
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      fullName: true,
      passwordHash: true,
      status: true,
      failedLoginCount: true,
      lockedUntil: true,
      defaultCompanyId: true,
      platformRole: true,
    },
  });

  // Uniform failure message and comparable timing whether or not the address
  // exists, so this endpoint cannot be used to enumerate customers.
  const invalidCredentials = fail(
    "That email address and password do not match an account.",
    { code: ACTION_ERROR.INVALID_CREDENTIALS },
  );

  if (!user) {
    await fakeVerifyPassword(password);
    await recordAuditLog({
      action: AUDIT_ACTION.SIGN_IN_FAILED,
      module: "Auth",
      actorEmail: email,
      metadata: { reason: "unknown_account" },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return invalidCredentials;
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const retryAfterSeconds = Math.ceil(
      (user.lockedUntil.getTime() - Date.now()) / 1000,
    );
    await recordAuditLog({
      action: AUDIT_ACTION.SIGN_IN_BLOCKED,
      module: "Auth",
      userId: user.id,
      actorEmail: email,
      metadata: { reason: "locked" },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return fail(
      "This account is temporarily locked after repeated failed sign-ins. Try again shortly, or reset your password.",
      { code: ACTION_ERROR.ACCOUNT_LOCKED, retryAfterSeconds },
    );
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash);

  if (!passwordMatches) {
    const failedLoginCount = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount,
        lockedUntil:
          failedLoginCount >= LOCKOUT_THRESHOLD
            ? new Date(Date.now() + lockoutDuration(failedLoginCount))
            : null,
      },
    });

    await recordAuditLog({
      action: AUDIT_ACTION.SIGN_IN_FAILED,
      module: "Auth",
      userId: user.id,
      actorEmail: email,
      metadata: { reason: "bad_password", failedLoginCount },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return invalidCredentials;
  }

  if (
    user.status === UserStatus.SUSPENDED ||
    user.status === UserStatus.DEACTIVATED
  ) {
    await recordAuditLog({
      action: AUDIT_ACTION.SIGN_IN_BLOCKED,
      module: "Auth",
      userId: user.id,
      actorEmail: email,
      metadata: { reason: user.status.toLowerCase() },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return fail(
      "This account is not active. Please contact support if you believe this is a mistake.",
      { code: ACTION_ERROR.ACCOUNT_SUSPENDED },
    );
  }

  // Resolve the company to act within. A membership the user actually holds,
  // preferring their default; never anything supplied by the client.
  const membership = await prisma.membership.findFirst({
    where: {
      userId: user.id,
      status: "ACTIVE",
      company: { status: { not: "CANCELLED" } },
      ...(user.defaultCompanyId ? { companyId: user.defaultCompanyId } : {}),
    },
    select: { companyId: true },
  });

  const fallbackMembership = membership
    ? null
    : await prisma.membership.findFirst({
        where: {
          userId: user.id,
          status: "ACTIVE",
          company: { status: { not: "CANCELLED" } },
        },
        select: { companyId: true },
        orderBy: { createdAt: "asc" },
      });

  const companyId =
    membership?.companyId ?? fallbackMembership?.companyId ?? null;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      ...(companyId && !user.defaultCompanyId
        ? { defaultCompanyId: companyId }
        : {}),
    },
  });

  await createSession({
    userId: user.id,
    companyId,
    rememberMe,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  // A successful sign-in clears the account budget so a person who mistyped
  // twice and then succeeded is not throttled on their next visit. The IP
  // budget is deliberately left alone — a shared address is exactly where an
  // attacker hides.
  await clearRateLimit("SIGN_IN_ACCOUNT", email);

  await recordAuditLog({
    action: AUDIT_ACTION.SIGN_IN,
    module: "Auth",
    companyId,
    userId: user.id,
    actorEmail: email,
    metadata: { rememberMe },
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  // Where somebody lands depends on what they have. A member goes to their
  // business; somebody with none goes to onboarding — unless they run the
  // platform, in which case asking them to create a shop before they can
  // administer one is nonsense.
  const runsThePlatform =
    user.platformRole === "ADMIN" || user.platformRole === "SUPER_ADMIN";
  const fallback = companyId
    ? "/app"
    : runsThePlatform
      ? "/admin"
      : "/onboarding";

  return ok({ redirectTo: safeRedirectPath(input.next, fallback) });
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

export async function signOutAction(): Promise<never> {
  const session = await getAuthSession();
  const context = await getRequestContext();

  if (session) {
    await recordAuditLog({
      action: AUDIT_ACTION.SIGN_OUT,
      module: "Auth",
      companyId: session.companyId,
      userId: session.user.id,
      actorEmail: session.user.email,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }

  await destroySession(session?.id);
  redirect("/login");
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export type RegisterResult = { redirectTo: string; companySlug: string };

export async function registerAction(
  input: RegisterInput,
): Promise<ActionResult<RegisterResult>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Some details need attention.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  // The schema checks length and confirmation; the policy check is what
  // rejects breach-list entries and passwords built from the user's own name.
  const strength = evaluatePasswordStrength(parsed.data.account.password, {
    email: parsed.data.account.email,
    name: parsed.data.account.fullName,
  });
  if (!strength.acceptable) {
    return fail("Please choose a stronger password.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: {
        "account.password":
          strength.issues[0] ?? "This password is not acceptable.",
      },
    });
  }

  const context = await getRequestContext();
  const limit = await checkRateLimit(
    "REGISTER_IP",
    rateLimitKey(context.ipAddress),
  );
  if (!limit.allowed) {
    return fail(
      "Too many accounts have been created from this connection. Please try again later.",
      {
        code: ACTION_ERROR.RATE_LIMITED,
        retryAfterSeconds: limit.retryAfterSeconds,
      },
    );
  }

  try {
    const result = await registerOwner(parsed.data, {
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    await sendEmail(
      verificationEmail({
        to: parsed.data.account.email,
        name: parsed.data.account.fullName,
        token: result.verificationToken,
      }),
    );

    // Signed in immediately. Email verification is a prompt inside the app
    // rather than a wall in front of it: a retailer who cannot reach their
    // books until an email arrives simply leaves. Verification is required
    // before inviting team members or changing billing.
    await createSession({
      userId: result.userId,
      companyId: result.companyId,
      rememberMe: true,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return ok({ redirectTo: "/app", companySlug: result.companySlug });
  } catch (error) {
    if (error instanceof EmailAlreadyRegisteredError) {
      return fail(
        "An account already exists for this email address. Try signing in instead.",
        {
          code: ACTION_ERROR.EMAIL_TAKEN,
          fieldErrors: { "account.email": "This email is already registered." },
        },
      );
    }

    console.error("Registration failed", error);
    return fail(
      "We could not create your account. Nothing was saved — please try again.",
      { code: ACTION_ERROR.UNEXPECTED },
    );
  }
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Always reports success.
 *
 * Returning "no such account" would turn this endpoint into an account
 * enumeration oracle. The real owner of an unregistered address still gets an
 * email telling them a reset was attempted, which is more useful than silence.
 */
export async function forgotPasswordAction(input: {
  email: string;
}): Promise<ActionResult<{ sent: true }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Enter a valid email address.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  const { email } = parsed.data;
  const context = await getRequestContext();

  const [byIp, byAccount] = await Promise.all([
    checkRateLimit("PASSWORD_RESET_IP", rateLimitKey(context.ipAddress)),
    checkRateLimit("PASSWORD_RESET_ACCOUNT", email),
  ]);

  // Even the throttle response is uniform — a distinguishable "slow down" for
  // real accounts only would leak the same information.
  if (!byIp.allowed || !byAccount.allowed) {
    return ok({ sent: true });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, fullName: true, status: true },
  });

  if (!user || user.status === UserStatus.DEACTIVATED) {
    await sendEmail(passwordResetUnknownAccountEmail(email));
    return ok({ sent: true });
  }

  const { token, tokenHash } = issueToken();

  // Outstanding reset links are retired when a new one is requested, so a
  // forwarded or intercepted older email stops working.
  await prisma.$transaction(async (tx) => {
    await tx.verificationToken.updateMany({
      where: { userId: user.id, purpose: "PASSWORD_RESET", consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.verificationToken.create({
      data: {
        tokenHash,
        purpose: "PASSWORD_RESET",
        userId: user.id,
        email,
        expiresAt: expiresAt(TOKEN_TTL.PASSWORD_RESET_MS),
      },
    });
  });

  await sendEmail(
    passwordResetEmail({ to: email, name: user.fullName, token }),
  );

  await recordAuditLog({
    action: AUDIT_ACTION.PASSWORD_RESET_REQUESTED,
    module: "Auth",
    userId: user.id,
    actorEmail: email,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return ok({ sent: true });
}

export async function resetPasswordAction(input: {
  token: string;
  password: string;
  confirmPassword: string;
}): Promise<ActionResult<{ redirectTo: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  const context = await getRequestContext();
  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash: hashToken(parsed.data.token) },
    select: {
      id: true,
      userId: true,
      purpose: true,
      expiresAt: true,
      consumedAt: true,
      user: { select: { id: true, email: true, fullName: true, status: true } },
    },
  });

  const invalidToken = fail(
    "This reset link is no longer valid. Request a new one.",
    { code: ACTION_ERROR.TOKEN_INVALID },
  );

  if (
    !record ||
    record.purpose !== "PASSWORD_RESET" ||
    record.consumedAt ||
    record.expiresAt.getTime() <= Date.now() ||
    !record.user
  ) {
    return invalidToken;
  }

  const strength = evaluatePasswordStrength(parsed.data.password, {
    email: record.user.email,
    name: record.user.fullName,
  });
  if (!strength.acceptable) {
    return fail("Please choose a stronger password.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: {
        password: strength.issues[0] ?? "This password is not acceptable.",
      },
    });
  }

  const passwordHash = await hashPassword(parsed.data.password);

  await prisma.$transaction(async (tx) => {
    // Consume the token by id *and* by its unconsumed state, so two parallel
    // submissions of the same link cannot both succeed.
    const consumed = await tx.verificationToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw new Error("TOKEN_ALREADY_CONSUMED");
    }

    await tx.user.update({
      where: { id: record.userId! },
      data: {
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        // A reset proves control of the mailbox, which is what verification
        // was asking for anyway.
        emailVerifiedAt: new Date(),
        status:
          record.user!.status === UserStatus.PENDING_VERIFICATION
            ? UserStatus.ACTIVE
            : record.user!.status,
      },
    });

    // Anyone signed in with the old password loses access immediately. That is
    // the point of a reset when an account may already be compromised.
    await revokeAllSessions(record.userId!, tx);
  });

  await recordAuditLog({
    action: AUDIT_ACTION.PASSWORD_RESET_COMPLETED,
    module: "Auth",
    userId: record.userId,
    actorEmail: record.user.email,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return ok({ redirectTo: "/login?reset=1" });
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export type VerifyEmailOutcome =
  "verified" | "already_verified" | "invalid" | "expired";

export async function verifyEmailAction(
  token: string,
): Promise<VerifyEmailOutcome> {
  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      purpose: true,
      expiresAt: true,
      consumedAt: true,
      email: true,
      user: { select: { id: true, emailVerifiedAt: true, status: true } },
    },
  });

  if (!record || record.purpose !== "EMAIL_VERIFICATION" || !record.user) {
    return "invalid";
  }
  if (record.user.emailVerifiedAt) return "already_verified";
  if (record.consumedAt) return "invalid";
  if (record.expiresAt.getTime() <= Date.now()) return "expired";

  const context = await getRequestContext();

  await prisma.$transaction(async (tx) => {
    await tx.verificationToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.user.update({
      where: { id: record.userId! },
      data: {
        emailVerifiedAt: new Date(),
        status:
          record.user!.status === UserStatus.PENDING_VERIFICATION
            ? UserStatus.ACTIVE
            : record.user!.status,
      },
    });
  });

  await recordAuditLog({
    action: AUDIT_ACTION.EMAIL_VERIFIED,
    module: "Auth",
    userId: record.userId,
    actorEmail: record.email,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return "verified";
}

export async function resendVerificationAction(): Promise<
  ActionResult<{ sent: true }>
> {
  const session = await getAuthSession();
  if (!session) {
    return fail("Please sign in first.", {
      code: ACTION_ERROR.NOT_AUTHENTICATED,
    });
  }
  if (session.user.emailVerifiedAt) {
    return ok({ sent: true });
  }

  const limit = await checkRateLimit("RESEND_VERIFICATION", session.user.id);
  if (!limit.allowed) {
    return fail(
      "A verification email was sent recently. Please check your inbox.",
      {
        code: ACTION_ERROR.RATE_LIMITED,
        retryAfterSeconds: limit.retryAfterSeconds,
      },
    );
  }

  const { token, tokenHash } = issueToken();

  await prisma.$transaction(async (tx) => {
    await tx.verificationToken.updateMany({
      where: {
        userId: session.user.id,
        purpose: "EMAIL_VERIFICATION",
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
    await tx.verificationToken.create({
      data: {
        tokenHash,
        purpose: "EMAIL_VERIFICATION",
        userId: session.user.id,
        email: session.user.email,
        expiresAt: expiresAt(TOKEN_TTL.EMAIL_VERIFICATION_MS),
      },
    });
  });

  await sendEmail(
    verificationEmail({
      to: session.user.email,
      name: session.user.fullName,
      token,
    }),
  );

  return ok({ sent: true });
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/** Signs the user out of every device. Used from account security settings. */
export async function signOutEverywhereAction(): Promise<never> {
  const session = await getAuthSession();
  if (!session) redirect("/login");

  const context = await getRequestContext();
  await revokeAllSessions(session.user.id);

  await recordAuditLog({
    action: AUDIT_ACTION.SESSIONS_REVOKED,
    module: "Auth",
    companyId: session.companyId,
    userId: session.user.id,
    actorEmail: session.user.email,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  await destroySession(session.id);
  redirect("/login");
}
