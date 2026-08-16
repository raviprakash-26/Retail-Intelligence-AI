import type { PermissionKey } from "@/lib/rbac/permissions";

/**
 * Subscription plan definitions.
 *
 * These are *seed defaults*, not runtime constants: the platform admin panel
 * edits the `subscription_plans` rows, and entitlement checks read the row, so
 * pricing and packaging can change without a deployment.
 *
 * Entitlements are expressed as feature keys and numeric limits rather than as
 * `if (plan === "professional")` conditionals scattered through the codebase.
 */

export const FEATURE = {
  CORE_TRANSACTIONS: "core.transactions",
  ACCOUNTING_BASIC: "accounting.basic",
  ACCOUNTING_STATEMENTS: "accounting.statements",
  INVENTORY: "inventory",
  GST_PREPARATION: "gst.preparation",
  TAX_PREPARATION: "tax.preparation",
  ANALYTICS: "analytics",
  AI_ACCOUNTANT: "ai.accountant",
  AI_AUDITOR: "ai.auditor",
  AI_ADVISOR: "ai.advisor",
  FORECASTING: "forecasting",
  MULTI_BRANCH: "multi.branch",
  ADVANCED_PERMISSIONS: "permissions.advanced",
  PRIORITY_SUPPORT: "support.priority",
  EXPORTS: "reports.export",
} as const;

export type FeatureKey = (typeof FEATURE)[keyof typeof FEATURE];

/** `-1` means unlimited. */
export type PlanLimits = {
  users: number;
  branches: number;
  productsPerCompany: number;
  transactionsPerMonth: number;
  aiMessagesPerMonth: number;
  storageMb: number;
};

export type PlanDefinition = {
  key: string;
  name: string;
  tagline: string;
  description: string;
  /** Price in the smallest currency unit (paise) to avoid float drift. */
  priceMinor: number;
  currency: string;
  interval: "MONTHLY" | "QUARTERLY" | "YEARLY";
  trialDays: number;
  features: readonly FeatureKey[];
  limits: PlanLimits;
  /** Bullets shown on the pricing page, in order. */
  highlights: readonly string[];
  isPopular: boolean;
  sortOrder: number;
};

const STARTER_FEATURES: readonly FeatureKey[] = [
  FEATURE.CORE_TRANSACTIONS,
  FEATURE.ACCOUNTING_BASIC,
  FEATURE.ACCOUNTING_STATEMENTS,
  FEATURE.EXPORTS,
];

const PROFESSIONAL_FEATURES: readonly FeatureKey[] = [
  ...STARTER_FEATURES,
  FEATURE.INVENTORY,
  FEATURE.GST_PREPARATION,
  FEATURE.TAX_PREPARATION,
  FEATURE.ANALYTICS,
  FEATURE.AI_ACCOUNTANT,
  FEATURE.FORECASTING,
];

const BUSINESS_FEATURES: readonly FeatureKey[] = [
  ...PROFESSIONAL_FEATURES,
  FEATURE.AI_AUDITOR,
  FEATURE.AI_ADVISOR,
  FEATURE.MULTI_BRANCH,
  FEATURE.ADVANCED_PERMISSIONS,
  FEATURE.PRIORITY_SUPPORT,
];

export const PLAN_DEFINITIONS: readonly PlanDefinition[] = [
  {
    key: "starter",
    name: "Starter",
    tagline: "For the shop that just needs its books to be right.",
    description:
      "Record sales, purchases and expenses, and get a proper double-entry ledger with real financial statements behind them.",
    priceMinor: 49900,
    currency: "INR",
    interval: "MONTHLY",
    trialDays: 14,
    features: STARTER_FEATURES,
    limits: {
      users: 2,
      branches: 1,
      productsPerCompany: 250,
      transactionsPerMonth: 500,
      aiMessagesPerMonth: 0,
      storageMb: 500,
    },
    highlights: [
      "Sales, purchases and expenses",
      "Receipts and payments",
      "Automatic double-entry accounting",
      "Journal, ledger and trial balance",
      "Trading, P&L and balance sheet",
      "PDF and Excel exports",
      "2 users, 1 branch",
    ],
    isPopular: false,
    sortOrder: 1,
  },
  {
    key: "professional",
    name: "Professional",
    tagline: "For the growing retailer who wants answers, not just records.",
    description:
      "Everything in Starter, plus inventory, GST preparation, business analytics, revenue forecasting and the AI Accountant.",
    priceMinor: 129900,
    currency: "INR",
    interval: "MONTHLY",
    trialDays: 14,
    features: PROFESSIONAL_FEATURES,
    limits: {
      users: 6,
      branches: 2,
      productsPerCompany: 5_000,
      transactionsPerMonth: 5_000,
      aiMessagesPerMonth: 500,
      storageMb: 5_000,
    },
    highlights: [
      "Everything in Starter",
      "Inventory with stock valuation",
      "GST registers and GSTR-1 / 3B preparation",
      "Tax preparation workspace",
      "Business analytics dashboards",
      "Revenue and cash-flow forecasting",
      "AI Accountant",
      "6 users, 2 branches",
    ],
    isPopular: true,
    sortOrder: 2,
  },
  {
    key: "business",
    name: "Business",
    tagline: "For multi-branch operations that need oversight.",
    description:
      "Everything in Professional, plus the AI Auditor, advanced analytics, multi-branch operations and granular permissions.",
    priceMinor: 299900,
    currency: "INR",
    interval: "MONTHLY",
    trialDays: 14,
    features: BUSINESS_FEATURES,
    limits: {
      users: -1,
      branches: -1,
      productsPerCompany: -1,
      transactionsPerMonth: -1,
      aiMessagesPerMonth: 2_500,
      storageMb: 25_000,
    },
    highlights: [
      "Everything in Professional",
      "AI Auditor with audit scoring",
      "AI Business Advisor",
      "Unlimited branches and users",
      "Custom roles and granular permissions",
      "Advanced analytics and cohorts",
      "Priority support",
    ],
    isPopular: false,
    sortOrder: 3,
  },
] as const;

export const DEFAULT_TRIAL_PLAN_KEY = "professional";

export function getPlanDefinition(key: string): PlanDefinition | undefined {
  return PLAN_DEFINITIONS.find((plan) => plan.key === key);
}

/**
 * Permissions that additionally require a plan feature. A member may hold the
 * permission through their role and still be gated by the subscription — both
 * checks must pass.
 */
export const PERMISSION_FEATURE_REQUIREMENTS: Partial<
  Record<PermissionKey, FeatureKey>
> = {
  "ai.accountant": FEATURE.AI_ACCOUNTANT,
  "ai.auditor": FEATURE.AI_AUDITOR,
  "ai.advisor": FEATURE.AI_ADVISOR,
  "audit.run": FEATURE.AI_AUDITOR,
  "forecasting.view": FEATURE.FORECASTING,
  "analytics.view": FEATURE.ANALYTICS,
  // GST and tax preparation are gated on the page's view permission, because
  // the modules are read-only working papers with no separate act of
  // preparing. `gst.prepare` and `tax.prepare` sat here and in two role
  // templates and were checked by nothing.
  "gst.view": FEATURE.GST_PREPARATION,
  "tax.view": FEATURE.TAX_PREPARATION,
  "inventory.adjust": FEATURE.INVENTORY,
  "branches.manage": FEATURE.MULTI_BRANCH,
  "roles.manage": FEATURE.ADVANCED_PERMISSIONS,
  "reports.export": FEATURE.EXPORTS,
};
