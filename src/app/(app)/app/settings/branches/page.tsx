import type { Metadata } from "next";
import { Sparkles } from "lucide-react";
import { BranchManager } from "@/components/settings/branch-manager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FEATURE } from "@/lib/billing/plans";
import { requirePermission } from "@/server/auth/context";
import { featureGate } from "@/server/billing/guards";
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
  //
  // Read through the entitlement gate rather than off the plan row, so a
  // business that has been granted this individually gets it here too — two
  // readings of "what does this plan include" is two answers waiting to differ.
  const gate = await featureGate(context.company.id, FEATURE.MULTI_BRANCH);
  const multiBranchIncluded = gate.included;

  return (
    <div className="space-y-6">
      {!multiBranchIncluded && (
        <Alert variant="info">
          <Sparkles />
          <AlertTitle>Multiple branches need a higher plan</AlertTitle>
          <AlertDescription>
            <p>
              Your {gate.entitlements.planName} plan covers one location.
              Multiple branches are included from{" "}
              {gate.availableOn ?? "a higher plan"} onwards.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <BranchManager branches={branches} canManage={multiBranchIncluded} />
    </div>
  );
}
