import type { PermissionKey } from "@/lib/rbac/permissions";
import type { FeatureKey } from "@/lib/billing/plans";
import { FEATURE } from "@/lib/billing/plans";

/**
 * Application navigation.
 *
 * Three independent gates decide whether an item is usable:
 *
 *   • `permission` — what this member's role allows. Missing means hidden;
 *     showing someone a permanently locked door is worse than not showing it.
 *   • `feature` — what their subscription includes. Shown but marked, because
 *     an upgrade is an action they can take.
 *   • `phase` — whether it is built yet. Shown but marked, so the shape of the
 *     product is visible without a dozen links that look broken when clicked.
 *
 * The third gate disappears as the build progresses; it exists so this file is
 * an honest map of the product rather than a promise.
 */

export type NavStatus = "ready" | "planned";

export type NavItem = {
  label: string;
  href: string;
  icon: string;
  permission?: PermissionKey;
  /**
   * Shown when the member holds *any* of these.
   *
   * For the handful of pages that serve two modules at once — returns are
   * reachable from both sales and purchases — where a single `permission`
   * would hide the page from half the people entitled to it. The page still
   * checks each side itself; this only decides whether the link appears.
   */
  anyPermission?: readonly PermissionKey[];
  feature?: FeatureKey;
  status: NavStatus;
  /** Which build phase delivers it. Rendered on the placeholder page. */
  phase?: number;
  /** Shown on the mobile bottom bar. */
  primary?: boolean;
  /**
   * Highlighted only on its own path, never on a descendant.
   *
   * The dashboard lives at the application root, so without this it would
   * prefix-match every page in the product and appear active everywhere.
   */
  exact?: boolean;
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: "Overview",
    items: [
      {
        label: "Dashboard",
        href: "/app",
        icon: "LayoutDashboard",
        permission: "dashboard.view",
        status: "ready",
        primary: true,
        exact: true,
      },
    ],
  },
  {
    label: "Transactions",
    items: [
      {
        label: "Sales",
        href: "/app/sales",
        icon: "ReceiptIndianRupee",
        permission: "sales.view",
        status: "ready",
        primary: true,
      },
      {
        label: "Purchases",
        href: "/app/purchases",
        icon: "ShoppingCart",
        permission: "purchases.view",
        status: "ready",
        primary: true,
      },
      {
        label: "Returns",
        href: "/app/returns",
        icon: "Undo2",
        anyPermission: ["sales.view", "purchases.view"],
        status: "ready",
      },
      {
        label: "Expenses",
        href: "/app/expenses",
        icon: "Wallet",
        permission: "expenses.view",
        status: "ready",
        primary: true,
      },
      {
        label: "Receipts",
        href: "/app/receipts",
        icon: "ArrowDownToLine",
        permission: "receipts.view",
        status: "ready",
      },
      {
        label: "Payments",
        href: "/app/payments",
        icon: "ArrowUpFromLine",
        permission: "payments.view",
        status: "ready",
      },
    ],
  },
  {
    label: "Records",
    items: [
      {
        label: "Products",
        href: "/app/products",
        icon: "Package",
        permission: "products.view",
        status: "ready",
      },
      {
        label: "Customers",
        href: "/app/customers",
        icon: "Users",
        permission: "customers.view",
        status: "ready",
      },
      {
        label: "Suppliers",
        href: "/app/suppliers",
        icon: "Truck",
        permission: "suppliers.view",
        status: "ready",
      },
      {
        label: "Inventory",
        href: "/app/inventory",
        icon: "Boxes",
        permission: "inventory.view",
        feature: FEATURE.INVENTORY,
        status: "ready",
      },
      {
        label: "Employees",
        href: "/app/employees",
        icon: "IdCard",
        permission: "employees.view",
        status: "ready",
      },
    ],
  },
  {
    label: "Accounting",
    items: [
      {
        label: "Chart of accounts",
        href: "/app/accounting",
        icon: "BookOpenCheck",
        permission: "accounting.view",
        status: "ready",
        exact: true,
      },
      {
        label: "Journal",
        href: "/app/accounting/journal",
        icon: "NotebookPen",
        permission: "accounting.view",
        status: "ready",
      },
      {
        label: "Ledger",
        href: "/app/accounting/ledger",
        icon: "BookOpen",
        permission: "accounting.view",
        status: "ready",
      },
      {
        label: "Trial balance",
        href: "/app/accounting/trial-balance",
        icon: "Scale",
        permission: "accounting.view",
        status: "ready",
      },
      {
        label: "Statements",
        href: "/app/accounting/statements",
        icon: "FileChartColumn",
        permission: "accounting.view",
        status: "ready",
      },
      {
        label: "GST",
        href: "/app/gst",
        icon: "Landmark",
        permission: "gst.view",
        feature: FEATURE.GST_PREPARATION,
        status: "ready",
      },
      {
        label: "Income tax",
        href: "/app/tax",
        icon: "Calculator",
        permission: "tax.view",
        feature: FEATURE.TAX_PREPARATION,
        status: "ready",
      },
      {
        label: "Reports",
        href: "/app/reports",
        icon: "FileSpreadsheet",
        permission: "reports.view",
        status: "ready",
      },
    ],
  },
  {
    label: "Intelligence",
    items: [
      {
        label: "Analytics",
        href: "/app/analytics",
        icon: "ChartColumnBig",
        permission: "analytics.view",
        feature: FEATURE.ANALYTICS,
        status: "ready",
      },
      {
        label: "Forecasting",
        href: "/app/forecasting",
        icon: "TrendingUp",
        permission: "forecasting.view",
        feature: FEATURE.FORECASTING,
        status: "ready",
      },
      {
        label: "AI Accountant",
        href: "/app/ai/accountant",
        icon: "MessageSquareText",
        permission: "ai.accountant",
        feature: FEATURE.AI_ACCOUNTANT,
        status: "ready",
      },
      {
        label: "AI Auditor",
        href: "/app/ai/auditor",
        icon: "ShieldCheck",
        permission: "ai.auditor",
        feature: FEATURE.AI_AUDITOR,
        status: "ready",
      },
      {
        label: "AI Advisor",
        href: "/app/ai/advisor",
        icon: "Lightbulb",
        permission: "ai.advisor",
        feature: FEATURE.AI_ADVISOR,
        status: "ready",
      },
    ],
  },
  {
    label: "Business",
    items: [
      {
        label: "Settings",
        href: "/app/settings/business",
        icon: "Settings",
        permission: "settings.view",
        status: "ready",
      },
    ],
  },
] as const;

export type QuickAction = {
  label: string;
  href: string;
  icon: string;
  permission: PermissionKey;
  status: NavStatus;
  phase?: number;
};

/**
 * Shown in the top bar's "New" menu and on the mobile action sheet.
 *
 * Every href must be one a navigation item already points at — a quick action
 * for something not yet built lands on that module's page, which explains what
 * is coming and when. Pointing at the eventual `/new` route instead would give
 * a menu full of links that 404 today.
 */
export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    label: "New sale",
    href: "/app/sales/new",
    icon: "ReceiptIndianRupee",
    permission: "sales.create",
    status: "ready",
  },
  {
    label: "New purchase",
    href: "/app/purchases/new",
    icon: "ShoppingCart",
    permission: "purchases.create",
    status: "ready",
  },
  {
    label: "New expense",
    href: "/app/expenses/new",
    icon: "Wallet",
    permission: "expenses.create",
    status: "ready",
  },
  {
    label: "Record receipt",
    href: "/app/receipts/new",
    icon: "ArrowDownToLine",
    permission: "receipts.create",
    status: "ready",
  },
  {
    label: "Record payment",
    href: "/app/payments/new",
    icon: "ArrowUpFromLine",
    permission: "payments.create",
    status: "ready",
  },
  {
    label: "Add customer",
    href: "/app/customers",
    icon: "UserPlus",
    permission: "customers.manage",
    status: "ready",
  },
  {
    label: "Add supplier",
    href: "/app/suppliers",
    icon: "Truck",
    permission: "suppliers.manage",
    status: "ready",
  },
  {
    label: "Add product",
    href: "/app/products",
    icon: "Package",
    permission: "products.manage",
    status: "ready",
  },
] as const;

export type NavVisibility = {
  permissions: ReadonlySet<string>;
  features: ReadonlySet<string>;
};

/** True when the member's role allows the item at all. */
export function isPermitted(
  item: {
    permission?: PermissionKey;
    anyPermission?: readonly PermissionKey[];
  },
  visibility: NavVisibility,
): boolean {
  if (item.permission && !visibility.permissions.has(item.permission)) {
    return false;
  }
  if (item.anyPermission) {
    return item.anyPermission.some((key) => visibility.permissions.has(key));
  }
  return true;
}

/** True when the subscription includes it. Gated items still render, marked. */
export function isIncludedInPlan(
  item: { feature?: FeatureKey },
  visibility: NavVisibility,
): boolean {
  return !item.feature || visibility.features.has(item.feature);
}

/**
 * Sections filtered to what this member may see, with empty sections dropped.
 */
export function visibleSections(visibility: NavVisibility): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    label: section.label,
    items: section.items.filter((item) => isPermitted(item, visibility)),
  })).filter((section) => section.items.length > 0);
}

export function visibleQuickActions(visibility: NavVisibility): QuickAction[] {
  return QUICK_ACTIONS.filter((action) =>
    visibility.permissions.has(action.permission),
  );
}

export type NavTarget = { href: string; exact?: boolean };

/**
 * Which nav item a path belongs to.
 *
 * Longest match wins, so `/app/settings/team` highlights Settings rather than
 * whichever shorter href also prefixes it. An `exact` target claims only its
 * own path — otherwise the dashboard at `/app` would look active on every page
 * in the product, which is what the mobile bar showed before this existed.
 */
export function activeHref(
  pathname: string,
  targets: readonly NavTarget[],
): string | null {
  let best: string | null = null;
  for (const target of targets) {
    const matches = target.exact
      ? pathname === target.href
      : pathname === target.href || pathname.startsWith(`${target.href}/`);
    if (matches && (best === null || target.href.length > best.length)) {
      best = target.href;
    }
  }
  return best;
}
