import type { Metadata } from "next";
import { Sparkles } from "lucide-react";
import { BranchManager } from "@/components/settings/branch-manager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PLAN_DEFINITIONS, FEATURE } from "@/lib/billing/plans";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/context";
import { listBranches } from "@/server/company/branch-service";

export const metadata: Metadata = {
  title: "Branches",
  robots: { index: false, follow: false },
};

export default async function BranchSettingsPage() {
  const context = await requirePermission("branches.manage");
  const branches = await listBranches(context.company.id);

  // Multi-branch is a plan feature. The page still renders for a single-branch
  // tenant so they can edit the one they have, with the upgrade path stated
  // plainly rather than the button silently failing.
  const subscription = await prisma.subscription.findUnique({
    where: { companyId: context.company.id },
    select: { plan: { select: { features: true, name: true } } },
  });

  const features = Array.isArray(subscription?.plan.features)
    ? (subscription.plan.features as string[])
    : [];
  const multiBranchIncluded = features.includes(FEATURE.MULTI_BRANCH);
  const firstPlanWithMultiBranch = PLAN_DEFINITIONS.find((plan) =>
    plan.features.includes(FEATURE.MULTI_BRANCH),
  );

  return (
    <div className="space-y-6">
      {!multiBranchIncluded && (
        <Alert variant="info">
          <Sparkles />
          <AlertTitle>Multiple branches need a higher plan</AlertTitle>
          <AlertDescription>
            <p>
              Your {subscription?.plan.name ?? "current"} plan covers one
              location. Multiple branches are included from{" "}
              {firstPlanWithMultiBranch?.name ?? "a higher plan"} onwards.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <BranchManager branches={branches} canManage={multiBranchIncluded} />
    </div>
  );
}
