"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FEATURE_LABEL } from "@/lib/billing/entitlements";
import { FEATURE, type FeatureKey } from "@/lib/billing/plans";
import {
  setCompanyStatusAction,
  setFeatureOverrideAction,
} from "@/server/admin/actions";

/**
 * The two things an administrator can do to a business.
 *
 * Both are reversible and both are logged. Neither of them touches a record the
 * business entered — suspension stops people signing in, and an override
 * changes what their plan includes. Nothing here deletes anything, because a
 * button one person can press about somebody else's business should not be able
 * to.
 */

const FEATURES = Object.values(FEATURE) as FeatureKey[];

export function TenantControls({
  companyId,
  status,
  featureOverrides,
  planFeatures,
}: {
  companyId: string;
  status: string;
  featureOverrides: Record<string, boolean>;
  planFeatures: string[];
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  async function run(key: string, work: () => Promise<void>) {
    setPending(key);
    setError(null);
    await work();
    setPending(null);
    router.refresh();
  }

  const suspended = status === "SUSPENDED";

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <section className="rounded-xl border px-5 py-4">
        <h2 className="text-sm font-semibold">
          {suspended ? "This account is suspended" : "Suspending this account"}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Suspension stops the people in this business signing in. It deletes
          nothing, and the next administrator who disagrees can undo it. The
          reason is written to the audit log with your name on it.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!suspended && (
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why (recorded in the log)"
              className="max-w-xs"
              aria-label="Reason for suspending"
            />
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() =>
              void run("status", async () => {
                const result = await setCompanyStatusAction(
                  companyId,
                  suspended ? "ACTIVE" : "SUSPENDED",
                  reason,
                );
                if (!result.ok) setError(result.message);
                else setReason("");
              })
            }
          >
            {pending === "status" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            {suspended ? "Lift the suspension" : "Suspend"}
          </Button>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">What this business can use</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Its plan decides this. An override is how a promise made in a
            support conversation becomes a row somebody can find later, rather
            than a conditional in the code nobody remembers to remove. Clearing
            one puts the business back on whatever its plan says.
          </p>
        </div>
        <ul className="divide-y">
          {FEATURES.map((feature) => {
            const override = featureOverrides[feature];
            const fromPlan = planFeatures.includes(feature);
            const effective = override ?? fromPlan;

            return (
              <li
                key={feature}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5"
              >
                <div className="min-w-48">
                  <p className="text-sm">
                    {sentenceCase(FEATURE_LABEL[feature] ?? feature)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {override === undefined
                      ? fromPlan
                        ? "Included in the plan"
                        : "Not in the plan"
                      : override
                        ? "Granted to this business"
                        : "Withheld from this business"}
                  </p>
                </div>

                <div className="flex items-center gap-1.5">
                  <span
                    className={
                      effective
                        ? "text-xs text-success-foreground"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {effective ? "on" : "off"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending !== null}
                    onClick={() =>
                      void run(feature, async () => {
                        const result = await setFeatureOverrideAction(
                          companyId,
                          feature,
                          effective ? false : true,
                          featureOverrides,
                        );
                        if (!result.ok) setError(result.message);
                      })
                    }
                  >
                    {effective ? "Withhold" : "Grant"}
                  </Button>
                  {override !== undefined && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending !== null}
                      onClick={() =>
                        void run(`${feature}-clear`, async () => {
                          const result = await setFeatureOverrideAction(
                            companyId,
                            feature,
                            null,
                            featureOverrides,
                          );
                          if (!result.ok) setError(result.message);
                        })
                      }
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
