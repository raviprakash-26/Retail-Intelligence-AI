"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Info, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/format";
import { FEATURE_LABEL, UNLIMITED } from "@/lib/billing/entitlements";
import type { FeatureKey } from "@/lib/billing/plans";
import type {
  BillingOverview,
  PlanOption,
  UsageLine,
} from "@/server/billing/subscription-service";
import {
  cancelSubscriptionAction,
  changePlanAction,
  resumeSubscriptionAction,
} from "@/server/billing/actions";
import { UpgradeButton } from "@/components/billing/upgrade-button";

/**
 * The plan, what it includes, and what has been used of it.
 *
 * Two things this page will not do. It will not show a payment button that
 * resolves against nothing — where no provider is connected it says so, in
 * those words, and the button is simply absent. And it will not imply that a
 * lapsed subscription puts a business's own records out of reach, because it
 * does not.
 *
 * A third, now that payments work: it will not tell somebody they are on a new
 * plan because their browser came back from a checkout. Paying and being
 * upgraded are separate events, seconds apart, and the page says which one has
 * happened rather than assuming the second follows the first.
 */

const STATUS_LABEL: Record<string, string> = {
  TRIALING: "Trial",
  ACTIVE: "Active",
  PAST_DUE: "Payment overdue",
  CANCELLED: "Cancelled",
  EXPIRED: "Ended",
};

export function BillingView({
  overview,
  canManage,
}: {
  overview: BillingOverview;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function run(key: string, work: () => Promise<void>) {
    setPending(key);
    setError(null);
    setMessage(null);
    await work();
    setPending(null);
    router.refresh();
  }

  const { entitlements } = overview;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-4">
          <div>
            <p className="text-xs text-muted-foreground">Current plan</p>
            <p className="mt-0.5 flex items-center gap-2.5">
              <span className="text-lg font-semibold">
                {entitlements.planName}
              </span>
              <Badge
                variant={
                  entitlements.status === "ACTIVE" ||
                  entitlements.status === "TRIALING"
                    ? "muted"
                    : "warning"
                }
              >
                {STATUS_LABEL[entitlements.status] ?? entitlements.status}
              </Badge>
            </p>
          </div>
          <div className="text-right">
            <p className="tabular-figures text-lg font-semibold">
              {overview.currentPriceMinor === 0
                ? "—"
                : formatCurrency(overview.currentPriceMinor / 100, {
                    compactZeroDecimals: true,
                  })}
            </p>
            <p className="text-xs text-muted-foreground">
              {entitlements.status === "TRIALING"
                ? `Trial ends ${formatDate(entitlements.trialEndsAt ?? entitlements.currentPeriodEnd)}`
                : `Renews ${formatDate(entitlements.currentPeriodEnd)}`}
            </p>
          </div>
        </div>

        {entitlements.readOnly && entitlements.readOnlyReason && (
          <p className="flex items-start gap-2 border-t bg-warning/5 px-5 py-3 text-sm leading-relaxed">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{entitlements.readOnlyReason}</span>
          </p>
        )}

        {overview.cancelAtPeriodEnd && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
            <p className="text-sm text-muted-foreground">
              This plan ends on {formatDate(entitlements.currentPeriodEnd)}.
              Nothing changes until then.
            </p>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() =>
                  void run("resume", async () => {
                    const result = await resumeSubscriptionAction();
                    if (!result.ok) setError(result.message);
                  })
                }
              >
                Keep the plan
              </Button>
            )}
          </div>
        )}
      </section>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {message && <p className="text-sm">{message}</p>}

      <UsagePanel lines={overview.lines} period={overview.usage} />

      <section>
        <h2 className="text-sm font-semibold">Plans</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {overview.payments.available
            ? "Changing plan takes effect straight away."
            : overview.payments.reason}{" "}
          Moving to something cheaper, and cancelling, need no payment and
          happen at once.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {overview.plans.map((plan) => (
            <PlanCard
              key={plan.key}
              plan={plan}
              canManage={canManage}
              pending={pending === plan.key}
              disabled={pending !== null}
              paymentsAvailable={overview.payments.available}
              onBusyChange={(value) => setPending(value ? plan.key : null)}
              onNotice={setMessage}
              onError={setError}
              onChoose={() =>
                void run(plan.key, async () => {
                  const result = await changePlanAction(plan.key);
                  if (!result.ok) {
                    setError(result.message);
                    return;
                  }
                  setMessage(
                    result.data.overLimit.length > 0
                      ? `Now on ${result.data.planName}. You are over the new allowance for ${result.data.overLimit.join(", ")} — nothing has been removed, but you cannot add more until you are back inside it.`
                      : `Now on ${result.data.planName}.`,
                  );
                })
              }
            />
          ))}
        </div>
      </section>

      <IncludedPanel features={[...entitlements.features]} />

      {overview.invoices.length > 0 && (
        <InvoicePanel invoices={overview.invoices} />
      )}

      {canManage && !overview.cancelAtPeriodEnd && (
        <section className="rounded-xl border px-5 py-4">
          <h2 className="text-sm font-semibold">Cancelling</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            The plan runs to {formatDate(entitlements.currentPeriodEnd)} and
            then stops. Your books stay exactly where they are — readable,
            printable and exportable — and posting new entries is the only thing
            that needs an active plan.
          </p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() =>
              void run("cancel", async () => {
                const result = await cancelSubscriptionAction();
                if (!result.ok) setError(result.message);
              })
            }
          >
            {pending === "cancel" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Cancel at the end of the period
          </Button>
        </section>
      )}
    </div>
  );
}

function UsagePanel({
  lines,
  period,
}: {
  lines: UsageLine[];
  period: { periodStart: string; periodEnd: string };
}) {
  return (
    <section className="overflow-hidden rounded-xl border">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">What you have used</h2>
        <p className="text-xs text-muted-foreground">
          Counted from your records, not from a running total. Monthly figures
          cover {period.periodStart} to {period.periodEnd}.
        </p>
      </div>
      <ul className="divide-y">
        {lines.map((line) => (
          <li key={line.key} className="px-5 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="text-sm">{sentenceCase(line.label)}</span>
              <span className="tabular-figures text-sm text-muted-foreground">
                {line.used}
                {line.limit === UNLIMITED ? "" : ` of ${line.limit}`}
                {line.limit === UNLIMITED && (
                  <span className="ml-1.5 text-xs">no limit</span>
                )}
              </span>
            </div>
            {line.sharePercent !== null && (
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
                role="presentation"
              >
                <div
                  className={
                    line.exhausted ? "h-full bg-warning" : "h-full bg-primary"
                  }
                  style={{ width: `${line.sharePercent}%` }}
                />
              </div>
            )}
            {line.exhausted && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Used up. Nothing has been removed and nothing stops working —
                adding more is what waits for a bigger plan.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlanCard({
  plan,
  canManage,
  pending,
  disabled,
  paymentsAvailable,
  onChoose,
  onBusyChange,
  onNotice,
  onError,
}: {
  plan: PlanOption;
  canManage: boolean;
  pending: boolean;
  disabled: boolean;
  paymentsAvailable: boolean;
  onChoose: () => void;
  onBusyChange: (busy: boolean) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const blocked = plan.needsPayment && !paymentsAvailable;
  // A dearer plan is bought, not switched to. The two are different buttons
  // because they are different acts: one opens a payment, the other applies
  // immediately.
  const payable = plan.needsPayment && paymentsAvailable && canManage;

  return (
    <div className="flex flex-col rounded-xl border px-4 py-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{plan.name}</h3>
        {plan.isCurrent && <Badge variant="muted">Current</Badge>}
      </div>
      <p className="tabular-figures mt-1 text-lg font-semibold">
        {formatCurrency(plan.priceMinor / 100, { compactZeroDecimals: true })}
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          / {plan.interval.toLowerCase()}
        </span>
      </p>
      {plan.tagline && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {plan.tagline}
        </p>
      )}

      <div className="mt-3 grow" />

      {plan.isCurrent ? (
        <p className="text-xs text-muted-foreground">This is your plan.</p>
      ) : blocked ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Needs a payment, and no payment can be taken here.
        </p>
      ) : payable ? (
        <UpgradeButton
          planKey={plan.key}
          planName={plan.name}
          disabled={disabled}
          onBusyChange={onBusyChange}
          onNotice={onNotice}
          onError={onError}
        />
      ) : canManage ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onChoose}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Move to {plan.name}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Someone with billing access can change this.
        </p>
      )}
    </div>
  );
}

function IncludedPanel({ features }: { features: string[] }) {
  return (
    <section className="rounded-xl border px-5 py-4">
      <h2 className="text-sm font-semibold">What your plan includes</h2>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm">
            <Check className="mt-0.5 size-3.5 shrink-0 text-success-foreground" />
            <span>
              {sentenceCase(FEATURE_LABEL[feature as FeatureKey] ?? feature)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InvoicePanel({ invoices }: { invoices: BillingOverview["invoices"] }) {
  return (
    <section className="overflow-hidden rounded-xl border">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Billing history</h2>
      </div>
      <ul className="divide-y">
        {invoices.map((invoice) => (
          <li
            key={invoice.id}
            className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-2.5 text-sm"
          >
            <span>{invoice.number}</span>
            <span className="text-xs text-muted-foreground">
              {invoice.periodStart} to {invoice.periodEnd}
            </span>
            <span className="tabular-figures">
              {formatCurrency(invoice.amountMinor / 100, {
                compactZeroDecimals: true,
              })}
            </span>
            <Badge variant={invoice.status === "PAID" ? "muted" : "warning"}>
              {invoice.status.toLowerCase()}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function BillingFootnote() {
  return (
    <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Whatever happens to this subscription, the records you have entered stay
        yours. Nothing on this page can delete a ledger, and no state a
        subscription can reach makes your accounts unreadable.
      </span>
    </p>
  );
}
