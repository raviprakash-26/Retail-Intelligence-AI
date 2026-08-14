import "server-only";
import { cache } from "react";
import { forbidden, redirect, unauthorized } from "next/navigation";
import { prisma } from "@/lib/db";
import type { PermissionKey } from "@/lib/rbac/permissions";
import {
  getSessionFromCookie,
  type ActiveSession,
  type SessionUser,
} from "./session";

/**
 * The authorization context every server-side caller works from.
 *
 * Two rules this module exists to enforce:
 *
 *   1. `companyId` comes from the session, never from a request parameter, a
 *      form field or a URL segment. A user cannot reach another tenant's data
 *      by editing a URL, because the URL is not what selects the tenant.
 *
 *   2. Permissions are checked, not roles. Code asks "may they void a sale?",
 *      not "are they an accountant?".
 *
 * Resolution is wrapped in React's `cache`, so a page that calls
 * `requireCompanyContext()` in a layout and again in three components performs
 * one database round trip per request, not four.
 */

export type CompanyContext = {
  session: ActiveSession;
  user: SessionUser;
  membership: {
    id: string;
    roleId: string;
    roleKey: string;
    roleName: string;
    branchId: string | null;
  };
  company: {
    id: string;
    name: string;
    slug: string;
    currency: string;
    isDemo: boolean;
    status: "ONBOARDING" | "ACTIVE" | "SUSPENDED" | "CANCELLED";
    fiscalYearStartMonth: number;
    stateCode: string | null;
    gstRegistration: "UNREGISTERED" | "REGULAR" | "COMPOSITION" | "SEZ";
  };
  /** Every permission this member holds, already resolved. */
  permissions: ReadonlySet<PermissionKey>;
};

/** The signed-in user, or null. Never throws. */
export const getAuthSession = cache(async (): Promise<ActiveSession | null> => {
  return getSessionFromCookie();
});

/**
 * Companies the signed-in user may act within, for the business switcher.
 */
export const getUserCompanies = cache(
  async (): Promise<
    Array<{
      id: string;
      name: string;
      slug: string;
      isDemo: boolean;
      roleName: string;
    }>
  > => {
    const session = await getAuthSession();
    if (!session) return [];

    const memberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: {
        role: { select: { name: true } },
        company: {
          select: {
            id: true,
            name: true,
            slug: true,
            isDemo: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return memberships
      .filter((membership) => membership.company.status !== "CANCELLED")
      .map((membership) => ({
        id: membership.company.id,
        name: membership.company.name,
        slug: membership.company.slug,
        isDemo: membership.company.isDemo,
        roleName: membership.role.name,
      }));
  },
);

/**
 * Full tenant context, or null when the user is signed out, has no active
 * membership, or the session points at a company they have since lost access to.
 */
export const getCompanyContext = cache(
  async (): Promise<CompanyContext | null> => {
    const session = await getAuthSession();
    if (!session) return null;

    // The session's company is a *claim*; the membership lookup is what
    // authorises it. A user removed from a company loses access on their next
    // request even though their cookie still names that company.
    const companyId = session.companyId ?? session.user.defaultCompanyId;
    if (!companyId) return null;

    const membership = await prisma.membership.findFirst({
      where: {
        userId: session.user.id,
        companyId,
        status: "ACTIVE",
      },
      select: {
        id: true,
        branchId: true,
        roleId: true,
        role: {
          select: {
            key: true,
            name: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
        company: {
          select: {
            id: true,
            name: true,
            slug: true,
            currency: true,
            isDemo: true,
            status: true,
            fiscalYearStartMonth: true,
            stateCode: true,
            gstRegistration: true,
          },
        },
      },
    });

    if (!membership) return null;
    if (membership.company.status === "CANCELLED") return null;

    return {
      session,
      user: session.user,
      membership: {
        id: membership.id,
        roleId: membership.roleId,
        roleKey: membership.role.key,
        roleName: membership.role.name,
        branchId: membership.branchId,
      },
      company: membership.company,
      permissions: new Set(
        membership.role.permissions.map(
          (entry) => entry.permission.key as PermissionKey,
        ),
      ),
    };
  },
);

/**
 * The signed-in user, or a redirect to sign-in.
 *
 * `next` carries the path the user was trying to reach so they land there
 * after authenticating instead of on a generic dashboard.
 */
export async function requireAuth(next?: string): Promise<ActiveSession> {
  const session = await getAuthSession();
  if (!session) {
    redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  }
  return session;
}

/**
 * Full tenant context, or a redirect.
 *
 * A signed-in user with no company is sent to onboarding rather than to
 * sign-in — they are authenticated, they just have nowhere to go yet. A
 * platform administrator with no company is sent to administration instead:
 * they have somewhere to go, and it is not a form asking them to open a shop.
 */
export async function requireCompanyContext(): Promise<CompanyContext> {
  const session = await getAuthSession();
  if (!session) redirect("/login");

  const context = await getCompanyContext();
  if (!context) {
    const runsThePlatform =
      session.user.platformRole === "ADMIN" ||
      session.user.platformRole === "SUPER_ADMIN";
    redirect(runsThePlatform ? "/admin" : "/onboarding");
  }

  return context;
}

/**
 * Whether the current member holds a permission.
 *
 * Use for conditional rendering. Hiding a control is presentation — the server
 * action behind it must still call `requirePermission`.
 */
export async function can(permission: PermissionKey): Promise<boolean> {
  const context = await getCompanyContext();
  return context?.permissions.has(permission) ?? false;
}

export async function canAny(
  ...permissions: readonly PermissionKey[]
): Promise<boolean> {
  const context = await getCompanyContext();
  if (!context) return false;
  return permissions.some((permission) => context.permissions.has(permission));
}

export async function canAll(
  ...permissions: readonly PermissionKey[]
): Promise<boolean> {
  const context = await getCompanyContext();
  if (!context) return false;
  return permissions.every((permission) => context.permissions.has(permission));
}

/**
 * Asserts a permission and returns the context.
 *
 * This is the gate for every protected operation. It returns the context so a
 * caller cannot forget to re-derive `companyId` from a trusted source.
 */
export async function requirePermission(
  permission: PermissionKey,
): Promise<CompanyContext> {
  const context = await requireCompanyContext();
  if (!context.permissions.has(permission)) {
    forbidden();
  }
  return context;
}

/** Raised by service code when a permission check fails outside a route. */
export class PermissionDeniedError extends Error {
  constructor(readonly permission: PermissionKey) {
    super(`Missing permission: ${permission}`);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Permission assertion for server actions.
 *
 * Actions return a result object rather than throwing a navigation signal, so
 * this throws a plain error the action can convert into a form-level message.
 */
export async function assertPermission(
  permission: PermissionKey,
): Promise<CompanyContext> {
  const context = await getCompanyContext();
  if (!context) unauthorized();
  if (!context.permissions.has(permission)) {
    throw new PermissionDeniedError(permission);
  }
  return context;
}

/** Platform-administration gate. Separate from tenant permissions by design. */
export async function requirePlatformAdmin(): Promise<ActiveSession> {
  const session = await requireAuth("/admin");
  if (
    session.user.platformRole !== "ADMIN" &&
    session.user.platformRole !== "SUPER_ADMIN"
  ) {
    forbidden();
  }
  return session;
}
