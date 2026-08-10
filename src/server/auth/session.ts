import "server-only";
import { cookies } from "next/headers";
import { prisma, type DbClient } from "@/lib/db";
import { env } from "@/lib/env";
import { hashToken, issueToken } from "@/lib/auth/tokens";

/**
 * Session lifecycle.
 *
 * Sessions are opaque, database-backed and revocable. A JWT would avoid the
 * lookup, but it cannot be revoked before it expires — and in a financial
 * product "remove this person's access now" has to mean now, not in twelve
 * hours.
 *
 * What is stored is only the SHA-256 digest of the token. A database
 * disclosure therefore yields nothing that can be replayed as a sign-in.
 * SHA-256 rather than bcrypt is correct here: the token already carries 256
 * bits of entropy, so there is no dictionary to slow down, and the lookup is
 * on the hot path of every request.
 */

/**
 * The `__Host-` prefix is enforced by the browser: it requires Secure, Path=/
 * and no Domain attribute, which makes the cookie impossible to set from a
 * subdomain. It only works over HTTPS, so development over http falls back.
 */
const SECURE_COOKIE_NAME = "__Host-riai_session";
const DEV_COOKIE_NAME = "riai_session";

function secureCookiesEnabled(): boolean {
  return env.APP_URL.startsWith("https://");
}

export function sessionCookieName(): string {
  return secureCookiesEnabled() ? SECURE_COOKIE_NAME : DEV_COOKIE_NAME;
}

/**
 * "Remember me" extends the absolute lifetime to 30 days. Without it the
 * session lives for the configured idle window, which defaults to 12 hours —
 * about a working day, so a shop's counter terminal does not sign out mid-shift.
 */
const REMEMBER_ME_SECONDS = 60 * 60 * 24 * 30;

/**
 * How stale `lastSeenAt` may get before a request refreshes it. Writing on
 * every request would mean a database write per page view for no benefit.
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  emailVerifiedAt: Date | null;
  platformRole: "NONE" | "SUPPORT" | "ADMIN" | "SUPER_ADMIN";
  defaultCompanyId: string | null;
};

export type ActiveSession = {
  id: string;
  user: SessionUser;
  /** The company this session is currently acting within, if any. */
  companyId: string | null;
  expiresAt: Date;
};

export type CreateSessionInput = {
  userId: string;
  companyId?: string | null;
  rememberMe?: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Issues a session and sets its cookie.
 *
 * Called after a successful sign-in, a registration, and a password reset —
 * every point at which the caller's identity has just been re-established.
 */
export async function createSession(
  input: CreateSessionInput,
  client: DbClient = prisma,
): Promise<{ token: string; expiresAt: Date }> {
  const { token, tokenHash } = issueToken();

  const lifetimeSeconds = input.rememberMe
    ? REMEMBER_ME_SECONDS
    : env.SESSION_MAX_AGE_SECONDS;
  const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000);

  // The session records the user's current epoch. Bumping the user's epoch
  // therefore invalidates every session issued before that moment, without
  // having to find and delete each one.
  const user = await client.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { sessionEpoch: true },
  });

  await client.session.create({
    data: {
      tokenHash,
      userId: input.userId,
      companyId: input.companyId ?? null,
      sessionEpoch: user.sessionEpoch,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      expiresAt,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: secureCookiesEnabled(),
    // Lax rather than Strict: Strict would drop the cookie when a user follows
    // a link from their email client, so a verification link would land them
    // on a signed-out page. Lax still blocks cross-site POSTs.
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });

  return { token, expiresAt };
}

/**
 * Resolves the current session from the request cookie.
 *
 * Returns null for anything that is not a live, valid session — expired,
 * revoked, superseded by an epoch bump, or belonging to a user who is no
 * longer active. Callers never have to check those conditions themselves.
 */
export async function getSessionFromCookie(): Promise<ActiveSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName())?.value;
  if (!token) return null;

  return resolveSessionToken(token);
}

/** Resolve a raw token. Split out so middleware can use it without cookies(). */
export async function resolveSessionToken(
  token: string,
): Promise<ActiveSession | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      companyId: true,
      expiresAt: true,
      revokedAt: true,
      sessionEpoch: true,
      lastSeenAt: true,
      user: {
        select: {
          id: true,
          email: true,
          fullName: true,
          avatarUrl: true,
          status: true,
          emailVerifiedAt: true,
          platformRole: true,
          defaultCompanyId: true,
          sessionEpoch: true,
        },
      },
    },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  // A password change or an explicit "sign out everywhere" bumps the user's
  // epoch, retiring every session issued before it.
  if (session.sessionEpoch !== session.user.sessionEpoch) return null;

  // A suspended or deactivated account loses access immediately, without
  // waiting for its sessions to expire.
  if (
    session.user.status === "SUSPENDED" ||
    session.user.status === "DEACTIVATED"
  ) {
    return null;
  }

  await touchSession(session.id, session.lastSeenAt);

  const { sessionEpoch: _epoch, ...user } = session.user;

  return {
    id: session.id,
    user,
    companyId: session.companyId,
    expiresAt: session.expiresAt,
  };
}

/** Refreshes `lastSeenAt`, rate-limited so it is not a write per request. */
async function touchSession(
  sessionId: string,
  lastSeenAt: Date,
): Promise<void> {
  if (Date.now() - lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return;
  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() },
    });
  } catch {
    // A failed touch is cosmetic. It must not fail the request it decorates.
  }
}

/** Points an existing session at a different company the user belongs to. */
export async function setSessionCompany(
  sessionId: string,
  companyId: string,
): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { companyId },
  });
}

/** Revokes one session and clears its cookie. */
export async function destroySession(sessionId?: string): Promise<void> {
  const cookieStore = await cookies();
  const name = sessionCookieName();
  const token = cookieStore.get(name)?.value;

  if (sessionId) {
    await prisma.session
      .updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => undefined);
  } else if (token) {
    await prisma.session
      .updateMany({
        where: { tokenHash: hashToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => undefined);
  }

  cookieStore.delete(name);
}

/**
 * Retires every session belonging to a user, everywhere.
 *
 * Bumping the epoch is what actually does it — marking rows revoked is
 * bookkeeping so the sessions list reflects reality. Doing both in one
 * transaction means there is no window in which a session is live but
 * displayed as ended.
 */
export async function revokeAllSessions(
  userId: string,
  client: DbClient = prisma,
): Promise<void> {
  await client.user.update({
    where: { id: userId },
    data: { sessionEpoch: { increment: 1 } },
  });
  await client.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Deletes sessions that expired or were revoked more than 30 days ago.
 *
 * Recently-ended sessions are kept so a user can see "signed out from Chrome
 * on Windows, two hours ago" when investigating suspicious activity.
 */
export async function pruneExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await prisma.session.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
    },
  });
  return result.count;
}
