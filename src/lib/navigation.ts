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
  feature?: FeatureKey;
  status: NavStatus;
  /** Which build phase delivers it. Rendered on the placeholder page. */
  phase?: number;
  /** Shown on the mobile bottom bar. */
  primary?: boolean;
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
      },
    ],
  },
  {
    label: "Transactions",
    items: [
      { label: "Sales", href: "/app/sales", icon: "ReceiptIndianRupee", permission: "sales.view", status: "planned", phase: 6, primary: true },
      { label: "Purchases", href: "/app/purchases", icon: "ShoppingCart", permission: "purchases.view", status: "planned", phase: 7, primary: true },
      { label: "Expenses", href: "/app/expenses", icon: "Wallet", permission: "expenses.view", status: "planned", phase: 8, primary: true },
      { label: "Receipts", href: "/app/receipts", icon: "ArrowDownToLine", permission: "receipts.view", status: "planned", phase: 9 },
      { label: "Payments", href: "/app/payments", icon: "ArrowUpFromLine", permission: "payments.view", status: "planned", phase: 9 },
    ],
  },
  {
    label: "Records",
    items: [
      { label: "Customers", href: "/app/customers", icon: "Users", permission: "customers.view", status: "planned", phase: 5 },
      { label: "Suppliers", href: "/app/suppliers", icon: "Truck", permission: "suppliers.view", status: "planned", phase: 5 },
      { label: "Inventory", href: "/app/inventory", icon: "Package", permission: "inventory.view", feature: FEATURE.INVENTORY, status: "planned", phase: 15 },
      { label: "Employees", href: "/app/employees", icon: "IdCard", permission: "employees.view", status: "planned", phase: 5 },
    ],
  },
  {
    label: "Accounting",
    items: [
      { label: "Accounting", href: "/app/accounting", icon: "BookOpenCheck", permission: "accounting.view", status: "planned", phase: 11 },
      { label: "GST & Tax", href: "/app/gst", icon: "Landmark", permission: "gst.view", feature: FEATURE.GST_PREPARATION, status: "planned", phase: 16 },
      { label: "Reports", href: "/app/reports", icon: "FileSpreadsheet", permission: "reports.view", status: "planned", phase: 39 },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { label: "Analytics", href: "/app/analytics", icon: "ChartColumnBig", permission: "analytics.view", feature: FEATURE.ANALYTICS, status: "planned", phase: 18 },
      { label: "Forecasting", href: "/app/forecasting", icon: "TrendingUp", permission: "forecasting.view", feature: FEATURE.FORECASTING, status: "planned", phase: 19 },
      { label: "AI Accountant", href: "/app/ai/accountant", icon: "MessageSquareText", permission: "ai.accountant", feature: FEATURE.AI_ACCOUNTANT, status: "planned", phase: 20 },
      { label: "AI Auditor", href: "/app/ai/auditor", icon: "ShieldCheck", permission: "ai.auditor", feature: FEATURE.AI_AUDITOR, status: "planned", phase: 21 },
    ],
  },
  {
    label: "Business",
    items: [
      { label: "Settings", href: "/app/settings/business", icon: "Settings", permission: "settings.view", status: "ready" },
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

/** Shown in the top bar's "New" menu and on the mobile action sheet. */
export const QUICK_ACTIONS: readonly QuickAction[] = [
  { label: "New sale", href: "/app/sales/new", icon: "ReceiptIndianRupee", permission: "sales.create", status: "planned", phase: 6 },
  { label: "New purchase", href: "/app/purchases/new", icon: "ShoppingCart", permission: "purchases.create", status: "planned", phase: 7 },
  { label: "New expense", href: "/app/expenses/new", icon: "Wallet", permission: "expenses.create", status: "planned", phase: 8 },
  { label: "Record receipt", href: "/app/receipts/new", icon: "ArrowDownToLine", permission: "receipts.create", status: "planned", phase: 9 },
  { label: "Record payment", href: "/app/payments/new", icon: "ArrowUpFromLine", permission: "payments.create", status: "planned", phase: 9 },
  { label: "Add customer", href: "/app/customers/new", icon: "UserPlus", permission: "customers.manage", status: "planned", phase: 5 },
  { label: "Add supplier", href: "/app/suppliers/new", icon: "Truck", permission: "suppliers.manage", status: "planned", phase: 5 },
  { label: "Add product", href: "/app/products/new", icon: "Package", permission: "products.manage", status: "planned", phase: 5 },
] as const;

export type NavVisibility = {
  permissions: ReadonlySet<string>;
  features: ReadonlySet<string>;
};

/** True when the member's role allows the item at all. */
export function isPermitted(
  item: { permission?: PermissionKey },
  visibility: NavVisibility,
): boolean {
  return !item.permission || visibility.permissions.has(item.permission);
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
  return QUICK_ACTIONS.filter((action) => visibility.permissions.has(action.permission));
}

/**
 * Which nav item a path belongs to.
 *
 * Longest match wins so `/app/settings/team` highlights Settings rather than
 * Dashboard, which `/app` would otherwise claim by prefix.
 */
export function activeHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches = pathname === href || pathname.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}
