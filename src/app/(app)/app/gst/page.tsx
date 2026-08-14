import type { Metadata } from "next";
import { GstWorkingPaperView } from "@/components/gst/gst-working-paper";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { FEATURE } from "@/lib/billing/plans";
import { PlanLocked } from "@/components/billing/plan-locked";
import { featureGate } from "@/server/billing/guards";
import { requirePermission } from "@/server/auth/context";
import {
  getGstWorkingPaper,
  gstPeriods,
} from "@/server/gst/gst-return-service";

export const metadata: Metadata = {
  title: "GST",
  robots: { index: false, follow: false },
};

/**
 * The GST working paper.
 *
 * A preparation, never a filing. The platform reads the tax already recorded on
 * the invoices and bills, applies the set-off rules in the order they are
 * prescribed, reconciles the register against the ledger, and stops. Filing
 * happens on the GST portal, by a person who has reviewed this.
 */
export default async function GstPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("gst.view");

  // The navigation marks this when a plan does not include it, but marking is
  // presentation. Anybody can type the URL, so the page asks as well.
  const gate = await featureGate(context.company.id, FEATURE.GST_PREPARATION);
  if (!gate.included) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <PlanLocked
          feature={FEATURE.GST_PREPARATION}
          planName={gate.entitlements.planName}
          availableOn={gate.availableOn}
        />
      </div>
    );
  }
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    const found = Array.isArray(value) ? value[0] : value;
    return found || undefined;
  };

  const periods = await gstPeriods(context.company.id);
  const now = new Date();
  const fallback = periods[0] ?? {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
  };

  const year = Number(single("year") ?? fallback.year) || fallback.year;
  const month = Number(single("month") ?? fallback.month) || fallback.month;

  const paper = await getGstWorkingPaper({
    companyId: context.company.id,
    year,
    month: Math.min(12, Math.max(1, month)),
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="GST"
        description="A working paper built from the tax on the invoices and bills you have already recorded. It is prepared for your review — filing happens on the GST portal."
      />

      <GstWorkingPaperView paper={paper} periods={periods} />
    </div>
  );
}
