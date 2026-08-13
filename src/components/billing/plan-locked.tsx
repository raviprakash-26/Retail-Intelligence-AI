import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FEATURE_LABEL } from "@/lib/billing/entitlements";
import type { FeatureKey } from "@/lib/billing/plans";

/**
 * What a module looks like when the plan does not include it.
 *
 * It names the thing rather than a feature key, says which plan has it, and
 * gives one way forward. It does not list everything the reader is missing or
 * push them towards the most expensive option — a shop that does not need
 * forecasting should be able to read this page and decide it does not need
 * forecasting.
 */
export function PlanLocked({
  feature,
  planName,
  availableOn,
}: {
  feature: FeatureKey;
  /** The plan they are on now. */
  planName: string;
  /** The cheapest plan that includes it, when one does. */
  availableOn?: string | null;
}) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-14 text-center">
      <Lock className="mx-auto size-5 text-muted-foreground" />
      <h2 className="mt-3 text-base font-semibold">
        {sentenceCase(FEATURE_LABEL[feature])} is not in your plan
      </h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
        You are on {planName}
        {availableOn
          ? `, and this is part of ${availableOn}.`
          : ", which does not include it."}{" "}
        Everything you have already recorded is unaffected and stays where it
        is.
      </p>
      <Button asChild className="mt-5" variant="outline">
        <Link href="/app/settings/billing">See the plans</Link>
      </Button>
    </div>
  );
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
