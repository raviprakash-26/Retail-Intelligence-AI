import type { Metadata } from "next";
import { PlanEditor } from "@/components/admin/plan-editor";
import { listPlans } from "@/server/admin/admin-service";

export const metadata: Metadata = {
  title: "Plans",
  robots: { index: false, follow: false },
};

/**
 * The price list.
 *
 * These rows are what every entitlement check in the product reads, which is
 * why packaging can change without a deployment — and why a change here reaches
 * every business on that plan at once.
 */
export default async function AdminPlansPage() {
  const plans = await listPlans();
  return <PlanEditor plans={plans} />;
}
