import "server-only";
import { CompanyStatus, PlatformRole, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditLog } from "@/server/audit/audit-log";

/**
 * Running the platform.
 *
 * Everything here answers a question about *use of the service* — which plan,
 * how many users, how many entries last month, whether an account is suspended.
 * Nothing here reads a tenant's ledger, and there is no query in this file that
 * touches a journal line, an invoice amount or a customer name. See
 * `lib/admin/scope.ts` for where that line is drawn and why.
 *
 * Every change an administrator makes is written to the audit log with their
 * identity attached, in the same append-only table the tenants' own actions go
 * to. Administration that leaves no trace is indistinguishable from a breach
 * afterwards.
 */

export type PlatformOverview = {
  tenants: {
    total: number;
    active: number;
    onboarding: number;
    suspended: number;
    cancelled: number;
    demo: number;
  };
  signups: { thisMonth: number; lastMonth: number };
  subscriptions: {
    trialing: number;
    active: number;
    pastDue: number;
    cancelled: number;
    expired: number;
  };
  /** Plan mix, and what the platform bills for each. Its own revenue, not theirs. */
  planMix: {
    key: string;
    name: string;
    priceMinor: number;
    tenants: number;
  }[];
  /** Monthly recurring revenue in minor units, from plan prices. */
  monthlyRecurringMinor: number;
  users: { total: number; active: number; admins: number };
};

export type TenantRow = {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  isDemo: boolean;
  planName: string | null;
  planKey: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  users: number;
  branches: number;
  /** How many documents were entered this month. A count, never an amount. */
  entriesThisMonth: number;
  createdAt: string;
};

export type TenantList = {
  rows: TenantRow[];
  total: number;
  page: number;
  pageCount: number;
};

export const TENANT_PAGE_SIZE = 20;

const isoOrNull = (value: Date | null | undefined): string | null =>
  value?.toISOString() ?? null;

function monthWindow(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const previousStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );
  return { start, end, previousStart };
}

export async function getPlatformOverview(
  now = new Date(),
): Promise<PlatformOverview> {
  const { start, end, previousStart } = monthWindow(now);

  const [byStatus, demo, thisMonth, lastMonth, subs, plans, users] =
    await Promise.all([
      prisma.company.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.company.count({ where: { isDemo: true } }),
      prisma.company.count({ where: { createdAt: { gte: start, lt: end } } }),
      prisma.company.count({
        where: { createdAt: { gte: previousStart, lt: start } },
      }),
      prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.subscriptionPlan.findMany({
        select: {
          key: true,
          name: true,
          priceMinor: true,
          _count: { select: { subscriptions: true } },
        },
        orderBy: { sortOrder: "asc" },
      }),
      Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { status: "ACTIVE" } }),
        prisma.user.count({
          where: {
            platformRole: {
              in: [PlatformRole.ADMIN, PlatformRole.SUPER_ADMIN],
            },
          },
        }),
      ]),
    ]);

  const statusCount = (status: CompanyStatus): number =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0;

  const subCount = (status: string): number =>
    subs.find((row) => row.status === status)?._count._all ?? 0;

  // What the platform bills, from its own price list. Counted only for
  // subscriptions that are actually paying: a trial is not revenue, and a
  // dashboard that says otherwise is the first step to believing it.
  const payingByPlan = await prisma.subscription.groupBy({
    by: ["planId"],
    where: { status: "ACTIVE" },
    _count: { _all: true },
  });
  const planRows = await prisma.subscriptionPlan.findMany({
    select: { id: true, priceMinor: true },
  });
  const priceById = new Map(planRows.map((row) => [row.id, row.priceMinor]));
  const monthlyRecurringMinor = payingByPlan.reduce(
    (total, row) => total + (priceById.get(row.planId) ?? 0) * row._count._all,
    0,
  );

  const [totalUsers, activeUsers, adminUsers] = users;

  return {
    tenants: {
      total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
      active: statusCount(CompanyStatus.ACTIVE),
      onboarding: statusCount(CompanyStatus.ONBOARDING),
      suspended: statusCount(CompanyStatus.SUSPENDED),
      cancelled: statusCount(CompanyStatus.CANCELLED),
      demo,
    },
    signups: { thisMonth, lastMonth },
    subscriptions: {
      trialing: subCount("TRIALING"),
      active: subCount("ACTIVE"),
      pastDue: subCount("PAST_DUE"),
      cancelled: subCount("CANCELLED"),
      expired: subCount("EXPIRED"),
    },
    planMix: plans.map((plan) => ({
      key: plan.key,
      name: plan.name,
      priceMinor: plan.priceMinor,
      tenants: plan._count.subscriptions,
    })),
    monthlyRecurringMinor,
    users: { total: totalUsers, active: activeUsers, admins: adminUsers },
  };
}

export async function listTenants(params: {
  query?: string;
  status?: CompanyStatus;
  planKey?: string;
  page?: number;
  now?: Date;
}): Promise<TenantList> {
  const page = Math.max(1, params.page ?? 1);
  const now = params.now ?? new Date();
  const { start, end } = monthWindow(now);
  const query = params.query?.trim() ?? "";

  const where: Prisma.CompanyWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.planKey
      ? { subscription: { plan: { key: params.planKey } } }
      : {}),
    ...(query
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" as const } },
            { slug: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, companies] = await Promise.all([
    prisma.company.count({ where }),
    prisma.company.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * TENANT_PAGE_SIZE,
      take: TENANT_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        isDemo: true,
        createdAt: true,
        subscription: {
          select: {
            status: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            plan: { select: { key: true, name: true } },
          },
        },
        _count: { select: { memberships: true, branches: true } },
      },
    }),
  ]);

  // Counts of documents entered, per tenant, in one query rather than one per
  // row. Only how many — nothing selects an amount.
  const ids = companies.map((company) => company.id);
  const [sales, purchases, expenses] = await Promise.all([
    prisma.sale.groupBy({
      by: ["companyId"],
      where: { companyId: { in: ids }, createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    prisma.purchase.groupBy({
      by: ["companyId"],
      where: { companyId: { in: ids }, createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    prisma.expense.groupBy({
      by: ["companyId"],
      where: { companyId: { in: ids }, createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
  ]);

  const entries = new Map<string, number>();
  for (const row of [...sales, ...purchases, ...expenses]) {
    entries.set(
      row.companyId,
      (entries.get(row.companyId) ?? 0) + row._count._all,
    );
  }

  return {
    rows: companies.map((company) => ({
      id: company.id,
      name: company.name,
      slug: company.slug,
      status: company.status,
      isDemo: company.isDemo,
      planKey: company.subscription?.plan.key ?? null,
      planName: company.subscription?.plan.name ?? null,
      subscriptionStatus: company.subscription?.status ?? null,
      trialEndsAt: isoOrNull(company.subscription?.trialEndsAt),
      currentPeriodEnd: isoOrNull(company.subscription?.currentPeriodEnd),
      users: company._count.memberships,
      branches: company._count.branches,
      entriesThisMonth: entries.get(company.id) ?? 0,
      createdAt: company.createdAt.toISOString(),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / TENANT_PAGE_SIZE)),
  };
}

export type TenantDetail = TenantRow & {
  /** Who can sign in, and as what. Names and roles, never their work. */
  members: {
    id: string;
    fullName: string;
    email: string;
    roleName: string;
    status: string;
    lastSignInAt: string | null;
  }[];
  featureOverrides: Record<string, boolean>;
  limitOverrides: Record<string, number>;
  /** The platform's own billing history for this tenant. */
  invoices: {
    number: string;
    status: string;
    amountMinor: number;
    periodStart: string;
    periodEnd: string;
  }[];
};

export async function getTenantDetail(
  companyId: string,
  now = new Date(),
): Promise<TenantDetail | null> {
  const single = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      isDemo: true,
      createdAt: true,
      subscription: {
        select: {
          status: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          featureOverrides: true,
          limitOverrides: true,
          plan: { select: { key: true, name: true } },
          invoices: {
            orderBy: { createdAt: "desc" },
            take: 12,
            select: {
              number: true,
              status: true,
              amountMinor: true,
              periodStart: true,
              periodEnd: true,
            },
          },
        },
      },
      memberships: {
        select: {
          id: true,
          status: true,
          role: { select: { name: true } },
          user: {
            select: {
              fullName: true,
              email: true,
              lastLoginAt: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
        take: 50,
      },
      _count: { select: { memberships: true, branches: true } },
    },
  });

  if (!single) return null;

  const { start, end } = monthWindow(now);
  const [sales, purchases, expenses] = await Promise.all([
    prisma.sale.count({
      where: { companyId, createdAt: { gte: start, lt: end } },
    }),
    prisma.purchase.count({
      where: { companyId, createdAt: { gte: start, lt: end } },
    }),
    prisma.expense.count({
      where: { companyId, createdAt: { gte: start, lt: end } },
    }),
  ]);

  const asBooleans = (value: unknown): Record<string, boolean> =>
    Object.fromEntries(
      Object.entries(
        (value && typeof value === "object" ? value : {}) as Record<
          string,
          unknown
        >,
      ).filter(([, entry]) => typeof entry === "boolean"),
    ) as Record<string, boolean>;

  const asNumbers = (value: unknown): Record<string, number> =>
    Object.fromEntries(
      Object.entries(
        (value && typeof value === "object" ? value : {}) as Record<
          string,
          unknown
        >,
      ).filter(([, entry]) => typeof entry === "number"),
    ) as Record<string, number>;

  return {
    id: single.id,
    name: single.name,
    slug: single.slug,
    status: single.status,
    isDemo: single.isDemo,
    planKey: single.subscription?.plan.key ?? null,
    planName: single.subscription?.plan.name ?? null,
    subscriptionStatus: single.subscription?.status ?? null,
    trialEndsAt: isoOrNull(single.subscription?.trialEndsAt),
    currentPeriodEnd: isoOrNull(single.subscription?.currentPeriodEnd),
    users: single._count.memberships,
    branches: single._count.branches,
    entriesThisMonth: sales + purchases + expenses,
    createdAt: single.createdAt.toISOString(),
    members: single.memberships.map((membership) => ({
      id: membership.id,
      fullName: membership.user.fullName,
      email: membership.user.email,
      roleName: membership.role.name,
      status: membership.status,
      lastSignInAt: isoOrNull(membership.user.lastLoginAt),
    })),
    featureOverrides: asBooleans(single.subscription?.featureOverrides),
    limitOverrides: asNumbers(single.subscription?.limitOverrides),
    invoices: (single.subscription?.invoices ?? []).map((invoice) => ({
      number: invoice.number,
      status: invoice.status,
      amountMinor: invoice.amountMinor,
      periodStart: invoice.periodStart.toISOString().slice(0, 10),
      periodEnd: invoice.periodEnd.toISOString().slice(0, 10),
    })),
  };
}

// ---------------------------------------------------------------------------
// What an administrator may change
// ---------------------------------------------------------------------------

/**
 * Suspending an account.
 *
 * Suspension stops people signing in to it. It does not delete anything, and it
 * is reversible by the next administrator who disagrees — which is the only
 * safe shape for a button one person can press about somebody else's business.
 */
export async function setCompanyStatus(params: {
  companyId: string;
  status: CompanyStatus;
  adminId: string;
  adminEmail: string;
  reason?: string;
}): Promise<boolean> {
  const company = await prisma.company.findUnique({
    where: { id: params.companyId },
    select: { id: true, status: true, name: true },
  });
  if (!company) return false;

  await prisma.company.update({
    where: { id: params.companyId },
    data: { status: params.status },
  });

  await recordAuditLog({
    action: "admin.company_status_changed",
    module: "ADMIN",
    companyId: params.companyId,
    userId: params.adminId,
    actorEmail: params.adminEmail,
    entityType: "Company",
    entityId: params.companyId,
    metadata: {
      from: company.status,
      to: params.status,
      reason: params.reason ?? null,
    },
  });

  return true;
}

/**
 * Giving one business something its plan does not include.
 *
 * The override mechanism already exists in the entitlement engine; this is the
 * only supported way to set it, so a promise made in a support conversation
 * becomes a row somebody can find later rather than a conditional in the code.
 */
export async function setEntitlementOverride(params: {
  companyId: string;
  featureOverrides?: Record<string, boolean>;
  limitOverrides?: Record<string, number>;
  adminId: string;
  adminEmail: string;
}): Promise<boolean> {
  const subscription = await prisma.subscription.findUnique({
    where: { companyId: params.companyId },
    select: { id: true },
  });
  if (!subscription) return false;

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      ...(params.featureOverrides
        ? { featureOverrides: params.featureOverrides }
        : {}),
      ...(params.limitOverrides
        ? { limitOverrides: params.limitOverrides }
        : {}),
    },
  });

  await recordAuditLog({
    action: "admin.entitlement_override",
    module: "ADMIN",
    companyId: params.companyId,
    userId: params.adminId,
    actorEmail: params.adminEmail,
    entityType: "Subscription",
    entityId: subscription.id,
    metadata: {
      featureOverrides: params.featureOverrides ?? null,
      limitOverrides: params.limitOverrides ?? null,
    },
  });

  return true;
}

export type PlanRow = {
  id: string;
  key: string;
  name: string;
  tagline: string | null;
  priceMinor: number;
  currency: string;
  interval: string;
  trialDays: number;
  features: string[];
  limits: Record<string, number>;
  isPublic: boolean;
  isActive: boolean;
  tenants: number;
};

export async function listPlans(): Promise<PlanRow[]> {
  const plans = await prisma.subscriptionPlan.findMany({
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      key: true,
      name: true,
      tagline: true,
      priceMinor: true,
      currency: true,
      interval: true,
      trialDays: true,
      features: true,
      limits: true,
      isPublic: true,
      isActive: true,
      _count: { select: { subscriptions: true } },
    },
  });

  return plans.map((plan) => ({
    id: plan.id,
    key: plan.key,
    name: plan.name,
    tagline: plan.tagline,
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    interval: plan.interval,
    trialDays: plan.trialDays,
    features: Array.isArray(plan.features) ? (plan.features as string[]) : [],
    limits:
      plan.limits && typeof plan.limits === "object"
        ? (plan.limits as Record<string, number>)
        : {},
    isPublic: plan.isPublic,
    isActive: plan.isActive,
    tenants: plan._count.subscriptions,
  }));
}

/**
 * Changing what a plan costs or includes.
 *
 * The change applies to every business on that plan at once, which is the point
 * of entitlements being data — and is also why the price and the packaging are
 * the only fields this touches. The plan's `key` is not editable: subscriptions
 * point at it, and renaming an identifier under live rows is how a customer
 * silently loses a feature.
 */
export async function updatePlan(params: {
  planId: string;
  name?: string;
  tagline?: string | null;
  priceMinor?: number;
  trialDays?: number;
  features?: string[];
  limits?: Record<string, number>;
  isPublic?: boolean;
  isActive?: boolean;
  adminId: string;
  adminEmail: string;
}): Promise<boolean> {
  const existing = await prisma.subscriptionPlan.findUnique({
    where: { id: params.planId },
    select: { id: true, key: true, priceMinor: true, features: true },
  });
  if (!existing) return false;

  await prisma.subscriptionPlan.update({
    where: { id: params.planId },
    data: {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.tagline !== undefined ? { tagline: params.tagline } : {}),
      ...(params.priceMinor !== undefined
        ? { priceMinor: params.priceMinor }
        : {}),
      ...(params.trialDays !== undefined
        ? { trialDays: params.trialDays }
        : {}),
      ...(params.features !== undefined ? { features: params.features } : {}),
      ...(params.limits !== undefined ? { limits: params.limits } : {}),
      ...(params.isPublic !== undefined ? { isPublic: params.isPublic } : {}),
      ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
    },
  });

  await recordAuditLog({
    action: "admin.plan_updated",
    module: "ADMIN",
    userId: params.adminId,
    actorEmail: params.adminEmail,
    entityType: "SubscriptionPlan",
    entityId: params.planId,
    metadata: {
      key: existing.key,
      priceFrom: existing.priceMinor,
      priceTo: params.priceMinor ?? existing.priceMinor,
    },
  });

  return true;
}

export type AdminActionRow = {
  id: string;
  action: string;
  actorEmail: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
};

/** What administrators have been doing. Read from the same append-only table. */
export async function listAdminActions(limit = 50): Promise<AdminActionRow[]> {
  const rows = await prisma.auditLog.findMany({
    where: { module: "ADMIN" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      action: true,
      actorEmail: true,
      entityType: true,
      entityId: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorEmail: row.actorEmail,
    entityType: row.entityType,
    entityId: row.entityId,
    createdAt: row.createdAt.toISOString(),
  }));
}
