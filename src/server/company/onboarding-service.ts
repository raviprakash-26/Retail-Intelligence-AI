import "server-only";
import { prisma } from "@/lib/db";
import type { PermissionKey } from "@/lib/rbac/permissions";

/**
 * Setup checklist.
 *
 * Derived from what actually exists in the tenant rather than from a stored
 * "onboarding step" counter. A counter drifts the moment someone deletes the
 * product they added, and then tells the user they are finished when they are
 * not. Reading the real state cannot drift.
 */

export type ChecklistItem = {
  key: string;
  title: string;
  description: string;
  done: boolean;
  href: string;
  actionLabel: string;
  /** Hidden when the viewer lacks this permission. */
  requires?: PermissionKey;
  /** Skippable items do not count against completion. */
  optional?: boolean;
};

export type OnboardingChecklist = {
  items: ChecklistItem[];
  completed: number;
  total: number;
  /** 0-100, counting required items only. */
  percent: number;
  allRequiredDone: boolean;
};

export async function getOnboardingChecklist(params: {
  companyId: string;
  emailVerified: boolean;
  permissions: ReadonlySet<PermissionKey>;
}): Promise<OnboardingChecklist> {
  const { companyId } = params;

  const [
    company,
    productCount,
    customerCount,
    supplierCount,
    memberCount,
    saleCount,
  ] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: {
        gstin: true,
        gstRegistration: true,
        addressLine1: true,
        phone: true,
      },
    }),
    prisma.product.count({ where: { companyId, archivedAt: null } }),
    prisma.customer.count({ where: { companyId, archivedAt: null } }),
    prisma.supplier.count({ where: { companyId, archivedAt: null } }),
    prisma.membership.count({ where: { companyId, status: "ACTIVE" } }),
    prisma.sale.count({ where: { companyId } }),
  ]);

  const gstConfigured =
    company.gstRegistration === "UNREGISTERED" || Boolean(company.gstin);

  const all: ChecklistItem[] = [
    {
      key: "verify-email",
      title: "Confirm your email address",
      description:
        "Unlocks inviting your team and managing billing. Check your inbox for the link.",
      done: params.emailVerified,
      href: "/app",
      actionLabel: "Resend link",
    },
    {
      key: "business-details",
      title: "Complete your business details",
      description:
        "Your address and contact number appear on the invoices you issue.",
      done: Boolean(company.addressLine1 && company.phone),
      href: "/app/settings/business",
      actionLabel: "Add details",
      requires: "settings.manage",
    },
    {
      key: "gst-setup",
      title: "Confirm your GST position",
      description:
        "Determines whether your sales are taxed as CGST + SGST or as IGST.",
      done: gstConfigured,
      href: "/app/settings/business",
      actionLabel: "Set up GST",
      requires: "settings.manage",
    },
    {
      key: "products",
      title: "Add your products",
      description:
        "What you buy and sell. Stock, margins and GST all follow from these.",
      done: productCount > 0,
      href: "/app/products",
      actionLabel: "Add a product",
      requires: "products.manage",
    },
    {
      key: "customers",
      title: "Add a customer",
      description:
        "Needed for credit sales and outstanding tracking. Cash sales can use a walk-in customer.",
      done: customerCount > 0,
      href: "/app/customers",
      actionLabel: "Add a customer",
      requires: "customers.manage",
      optional: true,
    },
    {
      key: "suppliers",
      title: "Add a supplier",
      description:
        "Who you buy from, so purchases and payables have somewhere to go.",
      done: supplierCount > 0,
      href: "/app/suppliers",
      actionLabel: "Add a supplier",
      requires: "suppliers.manage",
      optional: true,
    },
    {
      key: "team",
      title: "Invite your team",
      description:
        "Give your accountant or cashier their own sign-in, with only the access they need.",
      done: memberCount > 1,
      href: "/app/settings/team",
      actionLabel: "Invite someone",
      requires: "users.manage",
      optional: true,
    },
    {
      key: "first-sale",
      title: "Record your first sale",
      description:
        "The accounting, stock movement and GST all follow from it automatically.",
      done: saleCount > 0,
      href: "/app/sales",
      actionLabel: "Record a sale",
      requires: "sales.create",
    },
  ];

  // An item a person cannot act on is noise on their checklist.
  const items = all.filter(
    (item) => !item.requires || params.permissions.has(item.requires),
  );

  const required = items.filter((item) => !item.optional);
  const completed = required.filter((item) => item.done).length;

  return {
    items,
    completed,
    total: required.length,
    percent:
      required.length === 0
        ? 100
        : Math.round((completed / required.length) * 100),
    allRequiredDone: completed === required.length,
  };
}
