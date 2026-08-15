/**
 * Permission catalogue and the role templates built from it.
 *
 * Authorization is permission-based. Application code asks "may this member
 * do `sales.create`?", never "is this member an Accountant?". Roles are just
 * named bundles, which means a tenant can create a custom role without any
 * code change and a permission can be re-bundled without hunting for role
 * checks scattered across modules.
 */

export const PERMISSIONS = {
  // Dashboard & analytics
  "dashboard.view": {
    module: "Dashboard",
    description: "View the business dashboard",
  },
  "analytics.view": {
    module: "Analytics",
    description: "View business analytics",
  },

  // Sales
  "sales.view": { module: "Sales", description: "View sales invoices" },
  "sales.create": { module: "Sales", description: "Create sales invoices" },
  "sales.edit": { module: "Sales", description: "Edit draft sales invoices" },
  "sales.void": { module: "Sales", description: "Void a posted sales invoice" },
  "sales.return": { module: "Sales", description: "Record sales returns" },

  // Purchases
  "purchases.view": { module: "Purchases", description: "View purchase bills" },
  "purchases.create": {
    module: "Purchases",
    description: "Create purchase bills",
  },
  "purchases.edit": {
    module: "Purchases",
    description: "Edit draft purchase bills",
  },
  "purchases.void": {
    module: "Purchases",
    description: "Void a posted purchase bill",
  },
  "purchases.return": {
    module: "Purchases",
    description: "Record purchase returns",
  },

  // Expenses
  "expenses.view": { module: "Expenses", description: "View expenses" },
  "expenses.create": { module: "Expenses", description: "Record expenses" },
  "expenses.edit": { module: "Expenses", description: "Edit draft expenses" },
  "expenses.void": { module: "Expenses", description: "Void a posted expense" },

  // Money movement
  "receipts.view": { module: "Receipts", description: "View receipts" },
  "receipts.create": {
    module: "Receipts",
    description: "Record money received",
  },
  "receipts.void": { module: "Receipts", description: "Void a posted receipt" },
  "payments.view": { module: "Payments", description: "View payments" },
  "payments.create": { module: "Payments", description: "Record money paid" },
  "payments.void": { module: "Payments", description: "Void a posted payment" },

  // Master data
  "customers.view": { module: "Customers", description: "View customers" },
  "customers.manage": {
    module: "Customers",
    description: "Create and edit customers",
  },
  "suppliers.view": { module: "Suppliers", description: "View suppliers" },
  "suppliers.manage": {
    module: "Suppliers",
    description: "Create and edit suppliers",
  },
  "products.view": { module: "Inventory", description: "View products" },
  "products.manage": {
    module: "Inventory",
    description: "Create and edit products",
  },
  "inventory.view": {
    module: "Inventory",
    description: "View stock positions",
  },
  "inventory.adjust": {
    module: "Inventory",
    description: "Adjust stock levels",
  },

  // Payroll
  "employees.view": { module: "Employees", description: "View employees" },
  "employees.manage": {
    module: "Employees",
    description: "Create and edit employees",
  },
  "payroll.view": { module: "Payroll", description: "View payroll runs" },
  "payroll.manage": { module: "Payroll", description: "Run and post payroll" },

  // Accounting
  "accounting.view": {
    module: "Accounting",
    description: "View journal, ledger and trial balance",
  },
  "accounting.journal.create": {
    module: "Accounting",
    description: "Post manual journal entries",
  },
  "accounting.journal.void": {
    module: "Accounting",
    description: "Void or reverse journal entries",
  },
  "accounting.accounts.manage": {
    module: "Accounting",
    description: "Manage the chart of accounts",
  },
  "accounting.period.close": {
    module: "Accounting",
    description: "Close and lock fiscal periods",
  },
  "accounting.statements.view": {
    module: "Accounting",
    description: "View financial statements",
  },
  "banking.view": {
    module: "Accounting",
    description: "View bank accounts and reconciliation",
  },
  "banking.reconcile": {
    module: "Accounting",
    description: "Import statements and match them to entries",
  },

  // Tax & GST
  "gst.view": {
    module: "GST",
    description: "View GST registers and summaries",
  },
  "gst.prepare": {
    module: "GST",
    description: "Prepare GST returns for review",
  },
  "gst.settings": { module: "GST", description: "Change tax configuration" },
  "tax.view": { module: "Tax", description: "View tax preparation workspace" },
  "tax.prepare": { module: "Tax", description: "Prepare tax estimates" },

  // AI
  "ai.accountant": { module: "AI", description: "Use the AI Accountant" },
  "ai.auditor": { module: "AI", description: "Use the AI Auditor" },
  "ai.advisor": { module: "AI", description: "Use the AI Business Advisor" },
  "forecasting.view": {
    module: "Forecasting",
    description: "View revenue and cash forecasts",
  },

  // Audit
  "audit.view": {
    module: "Audit",
    description: "View audit findings and scores",
  },
  "audit.run": { module: "Audit", description: "Run the audit rule set" },
  "audit.resolve": {
    module: "Audit",
    description: "Resolve or dismiss audit findings",
  },
  "auditlog.view": { module: "Audit", description: "View the activity log" },

  // Reports
  "reports.view": { module: "Reports", description: "View reports" },
  "reports.export": {
    module: "Reports",
    description: "Export reports to PDF/Excel/CSV",
  },

  // Settings & administration
  "settings.view": {
    module: "Settings",
    description: "View business settings",
  },
  "settings.manage": {
    module: "Settings",
    description: "Change business settings",
  },
  "users.view": { module: "Settings", description: "View team members" },
  "users.manage": {
    module: "Settings",
    description: "Invite, edit and remove team members",
  },
  "roles.manage": { module: "Settings", description: "Create and edit roles" },
  "branches.manage": { module: "Settings", description: "Manage branches" },
  // Deliberately its own permission, and deliberately not in any role list
  // below. Exporting one report is a normal day's work; taking a complete copy
  // of the books — every customer, every price, every entry — out of the
  // building is an owner's decision, and it should be one somebody has to be
  // given rather than one that arrives with a job title.
  "data.export": {
    module: "Settings",
    description: "Download a complete copy of this business's data",
  },
  "billing.view": {
    module: "Billing",
    description: "View the subscription and invoices",
  },
  "billing.manage": {
    module: "Billing",
    description: "Change plan and payment details",
  },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export const SYSTEM_ROLE = {
  OWNER: "owner",
  MANAGER: "manager",
  ACCOUNTANT: "accountant",
  CASHIER: "cashier",
  AUDITOR: "auditor",
  TAX_CONSULTANT: "tax_consultant",
} as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE)[keyof typeof SYSTEM_ROLE];

const MANAGER_PERMISSIONS: readonly PermissionKey[] = [
  "dashboard.view",
  "analytics.view",
  "sales.view",
  "sales.create",
  "sales.edit",
  "sales.return",
  "purchases.view",
  "purchases.create",
  "purchases.edit",
  "purchases.return",
  "expenses.view",
  "expenses.create",
  "expenses.edit",
  "receipts.view",
  "receipts.create",
  "payments.view",
  "payments.create",
  "customers.view",
  "customers.manage",
  "suppliers.view",
  "suppliers.manage",
  "products.view",
  "products.manage",
  "inventory.view",
  "inventory.adjust",
  "employees.view",
  "employees.manage",
  "payroll.view",
  "accounting.view",
  "accounting.statements.view",
  "banking.view",
  "gst.view",
  "tax.view",
  "ai.accountant",
  "ai.advisor",
  "forecasting.view",
  "audit.view",
  "reports.view",
  "reports.export",
  "settings.view",
  "users.view",
];

const ACCOUNTANT_PERMISSIONS: readonly PermissionKey[] = [
  "dashboard.view",
  "analytics.view",
  "sales.view",
  "sales.create",
  "sales.edit",
  "sales.void",
  "sales.return",
  "purchases.view",
  "purchases.create",
  "purchases.edit",
  "purchases.void",
  "purchases.return",
  "expenses.view",
  "expenses.create",
  "expenses.edit",
  "expenses.void",
  "receipts.view",
  "receipts.create",
  "receipts.void",
  "payments.view",
  "payments.create",
  "payments.void",
  "customers.view",
  "customers.manage",
  "suppliers.view",
  "suppliers.manage",
  "products.view",
  "products.manage",
  "inventory.view",
  "inventory.adjust",
  "employees.view",
  "payroll.view",
  "payroll.manage",
  "accounting.view",
  "accounting.journal.create",
  "accounting.journal.void",
  "accounting.accounts.manage",
  "accounting.period.close",
  "accounting.statements.view",
  "banking.view",
  "banking.reconcile",
  "gst.view",
  "gst.prepare",
  "tax.view",
  "tax.prepare",
  "ai.accountant",
  "forecasting.view",
  "audit.view",
  "reports.view",
  "reports.export",
  "settings.view",
];

// Deliberately narrow: a cashier records counter transactions and nothing
// else. No voids, no accounting, no reports, no master-data changes beyond
// adding a walk-in customer.
const CASHIER_PERMISSIONS: readonly PermissionKey[] = [
  "dashboard.view",
  "sales.view",
  "sales.create",
  "receipts.view",
  "receipts.create",
  "payments.view",
  "payments.create",
  "expenses.view",
  "expenses.create",
  "customers.view",
  "customers.manage",
  "products.view",
  "inventory.view",
];

// Read-only by construction: an auditor who can change records is not an
// auditor. The only write permission is resolving findings.
const AUDITOR_PERMISSIONS: readonly PermissionKey[] = [
  "dashboard.view",
  "analytics.view",
  "sales.view",
  "purchases.view",
  "expenses.view",
  "receipts.view",
  "payments.view",
  "customers.view",
  "suppliers.view",
  "products.view",
  "inventory.view",
  "employees.view",
  "payroll.view",
  "accounting.view",
  "accounting.statements.view",
  "banking.view",
  "gst.view",
  "tax.view",
  "ai.auditor",
  "audit.view",
  "audit.run",
  "audit.resolve",
  "auditlog.view",
  "reports.view",
  "reports.export",
];

const TAX_CONSULTANT_PERMISSIONS: readonly PermissionKey[] = [
  "dashboard.view",
  "sales.view",
  "purchases.view",
  "expenses.view",
  "customers.view",
  "suppliers.view",
  "accounting.view",
  "accounting.statements.view",
  "banking.view",
  "gst.view",
  "gst.prepare",
  "gst.settings",
  "tax.view",
  "tax.prepare",
  "reports.view",
  "reports.export",
];

export type RoleTemplate = {
  key: SystemRoleKey;
  name: string;
  description: string;
  /** `null` means every permission, including ones added in future releases. */
  permissions: readonly PermissionKey[] | null;
  sortOrder: number;
};

export const SYSTEM_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: SYSTEM_ROLE.OWNER,
    name: "Owner",
    description:
      "Full access to every module, including billing and team management.",
    permissions: null,
    sortOrder: 1,
  },
  {
    key: SYSTEM_ROLE.MANAGER,
    name: "Manager",
    description:
      "Runs day-to-day operations and reads reports. Cannot void posted entries or change accounting settings.",
    permissions: MANAGER_PERMISSIONS,
    sortOrder: 2,
  },
  {
    key: SYSTEM_ROLE.ACCOUNTANT,
    name: "Accountant",
    description:
      "Full accounting control: transactions, journals, period close, GST and tax preparation.",
    permissions: ACCOUNTANT_PERMISSIONS,
    sortOrder: 3,
  },
  {
    key: SYSTEM_ROLE.CASHIER,
    name: "Cashier",
    description:
      "Counter operations only — sales, receipts and payments. No voids and no reports.",
    permissions: CASHIER_PERMISSIONS,
    sortOrder: 4,
  },
  {
    key: SYSTEM_ROLE.AUDITOR,
    name: "Auditor",
    description:
      "Read-only across all financial data, plus the audit workspace and activity log.",
    permissions: AUDITOR_PERMISSIONS,
    sortOrder: 5,
  },
  {
    key: SYSTEM_ROLE.TAX_CONSULTANT,
    name: "Tax Consultant",
    description:
      "GST and tax modules with read access to the underlying transactions.",
    permissions: TAX_CONSULTANT_PERMISSIONS,
    sortOrder: 6,
  },
] as const;

/** Resolve a template to its concrete permission list. */
export function permissionsForRole(
  template: RoleTemplate,
): readonly PermissionKey[] {
  return template.permissions ?? ALL_PERMISSION_KEYS;
}

export function getRoleTemplate(key: string): RoleTemplate | undefined {
  return SYSTEM_ROLE_TEMPLATES.find((template) => template.key === key);
}
