"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/format";
import { FEATURE_LABEL } from "@/lib/billing/entitlements";
import type { FeatureKey } from "@/lib/billing/plans";
import type { PlanRow } from "@/server/admin/admin-service";
import { updatePlanAction } from "@/server/admin/actions";

/**
 * Editing the price list.
 *
 * The name, the price and whether a plan is offered publicly. Not the key —
 * subscriptions point at it, and renaming an identifier under live rows is how
 * a customer silently loses a feature. Not the features either, from here: a
 * packaging change that quietly removes something a hundred businesses are
 * using deserves more ceremony than a checkbox, and today it is a deployment.
 */
export function PlanEditor({ plans }: { plans: PlanRow[] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Every entitlement check in the product reads these rows, so a change
        here applies to every business on that plan at once — including the ones
        mid-period. Prices are held in paise to keep them exact.
      </p>

      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} />
      ))}
    </div>
  );
}

function PlanCard({ plan }: { plan: PlanRow }) {
  const router = useRouter();
  const [name, setName] = React.useState(plan.name);
  const [rupees, setRupees] = React.useState(String(plan.priceMinor / 100));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const dirty = name !== plan.name || Number(rupees) * 100 !== plan.priceMinor;

  async function save() {
    setPending(true);
    setError(null);
    setSaved(false);

    const priceMinor = Math.round(Number(rupees) * 100);
    if (!Number.isFinite(priceMinor)) {
      setError("That is not a price.");
      setPending(false);
      return;
    }

    const result = await updatePlanAction(plan.id, { name, priceMinor });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <section className="overflow-hidden rounded-xl border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <div>
          <h2 className="text-sm font-semibold">
            {plan.name}
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {plan.key}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            {plan.tenants} {plan.tenants === 1 ? "business" : "businesses"} on
            it · {plan.trialDays}-day trial
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!plan.isPublic && <Badge variant="muted">not offered</Badge>}
          {!plan.isActive && <Badge variant="warning">inactive</Badge>}
          <span className="tabular-figures text-sm font-medium">
            {formatCurrency(plan.priceMinor / 100, {
              compactZeroDecimals: true,
            })}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 px-5 py-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Name
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-56"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Price per month (₹)
          <Input
            value={rupees}
            inputMode="decimal"
            onChange={(event) => setRupees(event.target.value)}
            className="w-40"
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !dirty}
          onClick={() => void save()}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save
        </Button>
        {saved && !dirty && (
          <span className="text-xs text-muted-foreground">Saved.</span>
        )}
        {error && (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
      </div>

      <div className="border-t px-5 py-3">
        <p className="text-xs font-medium">Includes</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {plan.features
            .map((feature) => FEATURE_LABEL[feature as FeatureKey] ?? feature)
            .join(", ") || "nothing yet"}
        </p>
        <p className="mt-2 text-xs font-medium">Allowances</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {Object.entries(plan.limits)
            .map(
              ([key, value]) => `${key}: ${value === -1 ? "no limit" : value}`,
            )
            .join(" · ") || "none set"}
        </p>
      </div>
    </section>
  );
}
