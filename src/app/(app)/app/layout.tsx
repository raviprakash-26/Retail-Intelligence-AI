import { cookies } from "next/headers";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { AppTopbar } from "@/components/shell/app-topbar";
import { MobileNav } from "@/components/shell/mobile-nav";
import { SIDEBAR_COOKIE } from "@/lib/constants/cookies";
import { prisma } from "@/lib/db";
import { visibleQuickActions, visibleSections } from "@/lib/navigation";
import { getUserCompanies, requireCompanyContext } from "@/server/auth/context";
import {
  listFiscalYears,
  selectedFiscalYear,
} from "@/server/fiscal/fiscal-service";
import {
  countUnread,
  listNotifications,
} from "@/server/notifications/notification-service";

/**
 * Application shell.
 *
 * Everything the chrome needs is resolved once here and passed down, so a page
 * never re-queries the navigation, the company list or the fiscal years. The
 * tenant context itself is memoised per request, so `requireCompanyContext()`
 * in a page below costs nothing further.
 */
export default async function AppShellLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const context = await requireCompanyContext();
  const cookieStore = await cookies();

  const [
    companies,
    fiscalYears,
    selectedYear,
    notifications,
    unreadCount,
    subscription,
  ] = await Promise.all([
    getUserCompanies(),
    listFiscalYears(context.company.id),
    selectedFiscalYear(context.company.id),
    listNotifications({
      companyId: context.company.id,
      userId: context.user.id,
      limit: 15,
    }),
    countUnread({ companyId: context.company.id, userId: context.user.id }),
    prisma.subscription.findUnique({
      where: { companyId: context.company.id },
      select: { plan: { select: { features: true } } },
    }),
  ]);

  const includedFeatures = Array.isArray(subscription?.plan.features)
    ? (subscription.plan.features as string[])
    : [];

  const visibility = {
    permissions: context.permissions as ReadonlySet<string>,
    features: new Set(includedFeatures),
  };

  const sections = visibleSections(visibility);
  const quickActions = visibleQuickActions(visibility);

  const companyOptions = companies.map((company) => ({
    id: company.id,
    name: company.name,
    roleName: company.roleName,
    isDemo: company.isDemo,
  }));

  return (
    <div className="flex min-h-dvh">
      {/* Keyboard users should not have to tab the whole sidebar on every
          page to reach the content. */}
      <a
        href="#main-content"
        className="sr-only-focusable fixed top-4 left-4 z-[100] rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Skip to content
      </a>

      <AppSidebar
        sections={sections}
        includedFeatures={includedFeatures}
        defaultCollapsed={cookieStore.get(SIDEBAR_COOKIE)?.value === "1"}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar
          user={{
            fullName: context.user.fullName,
            email: context.user.email,
            roleName: context.membership.roleName,
            emailVerified: Boolean(context.user.emailVerifiedAt),
          }}
          companies={companyOptions}
          currentCompanyId={context.company.id}
          fiscalYears={fiscalYears.map((year) => ({
            id: year.id,
            label: year.label,
            startDate: year.startDate.toISOString(),
            endDate: year.endDate.toISOString(),
            isCurrent: year.isCurrent,
            isClosed: year.isClosed,
          }))}
          selectedFiscalYearId={selectedYear?.id ?? null}
          notifications={notifications.map((notification) => ({
            id: notification.id,
            severity: notification.severity,
            title: notification.title,
            body: notification.body,
            actionUrl: notification.actionUrl,
            readAt: notification.readAt?.toISOString() ?? null,
            createdAt: notification.createdAt.toISOString(),
          }))}
          unreadCount={unreadCount}
          quickActions={quickActions}
          canViewSettings={context.permissions.has("settings.view")}
        />

        <main id="main-content" className="flex-1 bg-muted/30">
          {children}
        </main>

        <MobileNav
          sections={sections}
          includedFeatures={includedFeatures}
          quickActions={quickActions}
        />
      </div>
    </div>
  );
}
