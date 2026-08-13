import type { Metadata } from "next";
import {
  BillingFootnote,
  BillingView,
} from "@/components/billing/billing-view";
import { can, requirePermission } from "@/server/auth/context";
import { getBillingOverview } from "@/server/billing/subscription-service";

export const metadata: Metadata = {
  title: "Plan",
  robots: { index: false, follow: false },
};

/**
 * The plan.
 *
 * Everything on it is read from the subscription and counted from the records:
 * what is included, what has been used, what each plan costs. Nothing here can
 * take a payment, and where that matters the page says so rather than showing a
 * button that resolves against nothing.
 */
export default async function BillingPage() {
  const context = await requirePermission("billing.view");
  const [overview, canManage] = await Promise.all([
    getBillingOverview(context.company.id),
    can("billing.manage"),
  ]);

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold">Plan and usage</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What this business is subscribed to, and what it has used of it.
        </p>
      </div>

      <BillingView overview={overview} canManage={canManage} />
      <BillingFootnote />
    </div>
  );
}
