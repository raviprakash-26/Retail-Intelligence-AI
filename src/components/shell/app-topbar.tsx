import Link from "next/link";
import { CompanySwitcher, type CompanyOption } from "@/components/company/company-switcher";
import { Logo } from "@/components/brand/logo";
import {
  FiscalYearSelector,
  type FiscalYearChoice,
} from "@/components/shell/fiscal-year-selector";
import {
  GlobalSearchProvider,
  GlobalSearchTrigger,
} from "@/components/shell/global-search";
import {
  NotificationsMenu,
  type NotificationView,
} from "@/components/shell/notifications-menu";
import { QuickActionsMenu } from "@/components/shell/quick-actions-menu";
import { UserMenu } from "@/components/shell/user-menu";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Separator } from "@/components/ui/separator";
import type { QuickAction } from "@/lib/navigation";

/**
 * Top bar.
 *
 * A server component: it renders already-resolved data and lets each
 * interactive control be its own small client island, so opening the theme
 * menu does not ship the search index or the notification list.
 */
export function AppTopbar({
  user,
  companies,
  currentCompanyId,
  fiscalYears,
  selectedFiscalYearId,
  notifications,
  unreadCount,
  quickActions,
  canViewSettings,
}: {
  user: {
    fullName: string;
    email: string;
    roleName: string;
    emailVerified: boolean;
  };
  companies: CompanyOption[];
  currentCompanyId: string;
  fiscalYears: FiscalYearChoice[];
  selectedFiscalYearId: string | null;
  notifications: NotificationView[];
  unreadCount: number;
  quickActions: QuickAction[];
  canViewSettings: boolean;
}) {
  return (
    <header className="bg-background/95 sticky top-0 z-30 border-b backdrop-blur">
      {/* One dialog, two buttons. The provider owns the dialog and the ⌘K
          listener; each trigger is only a button, so the responsive layout can
          place as many as it needs. */}
      <GlobalSearchProvider>
        <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
          {/* The sidebar carries the logo on desktop; on smaller screens it
              lives here so the brand is never absent. */}
          <Link href="/app" className="lg:hidden" aria-label="Dashboard">
            <Logo variant="mark" size="sm" />
          </Link>

          <div className="hidden flex-1 sm:block sm:max-w-sm">
            <GlobalSearchTrigger />
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <CompanySwitcher
              companies={companies}
              currentCompanyId={currentCompanyId}
            />

            <FiscalYearSelector
              years={fiscalYears}
              selectedId={selectedFiscalYearId}
            />

            <Separator
              orientation="vertical"
              className="mx-1 hidden h-6 sm:block"
            />

            <QuickActionsMenu actions={quickActions} />

            <NotificationsMenu
              notifications={notifications}
              unreadCount={unreadCount}
            />

            <ThemeToggle />

            <UserMenu
              fullName={user.fullName}
              email={user.email}
              roleName={user.roleName}
              emailVerified={user.emailVerified}
              canViewSettings={canViewSettings}
            />
          </div>
        </div>

        {/* Search moves to its own row on narrow screens rather than being
            squeezed out of the bar entirely. */}
        <div className="border-t px-4 py-2 sm:hidden">
          <GlobalSearchTrigger />
        </div>
      </GlobalSearchProvider>
    </header>
  );
}
