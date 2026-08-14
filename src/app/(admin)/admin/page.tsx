import type { Metadata } from "next";
import { formatCurrency } from "@/lib/format";
import { NO_IMPERSONATION_NOTE } from "@/lib/admin/scope";
import { getPlatformOverview } from "@/server/admin/admin-service";

export const metadata: Metadata = {
  title: "Platform overview",
  robots: { index: false, follow: false },
};

/**
 * How the service is doing.
 *
 * Counts of businesses and users, the plan mix, and what the platform itself
 * bills — its own revenue, from its own price list. Nothing on this page is a
 * figure from anybody's books.
 */
export default async function AdminOverviewPage() {
  const overview = await getPlatformOverview();

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Businesses"
          value={String(overview.tenants.total)}
          note={`${overview.tenants.active} active · ${overview.tenants.onboarding} onboarding`}
        />
        <Tile
          label="Signed up this month"
          value={String(overview.signups.thisMonth)}
          note={`${overview.signups.lastMonth} the month before`}
        />
        <Tile
          label="On a paid plan"
          value={String(overview.subscriptions.active)}
          note={`${overview.subscriptions.trialing} on trial`}
        />
        <Tile
          label="Monthly recurring"
          value={formatCurrency(overview.monthlyRecurringMinor / 100, {
            compactZeroDecimals: true,
          })}
          note="From paying subscriptions only — a trial is not revenue"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Panel title="Subscriptions">
          <Row label="Trialing" value={overview.subscriptions.trialing} />
          <Row label="Active" value={overview.subscriptions.active} />
          <Row label="Payment overdue" value={overview.subscriptions.pastDue} />
          <Row label="Cancelled" value={overview.subscriptions.cancelled} />
          <Row label="Ended" value={overview.subscriptions.expired} />
        </Panel>

        <Panel title="Accounts">
          <Row
            label="Suspended businesses"
            value={overview.tenants.suspended}
          />
          <Row
            label="Cancelled businesses"
            value={overview.tenants.cancelled}
          />
          <Row label="Demo businesses" value={overview.tenants.demo} />
          <Row label="People with sign-ins" value={overview.users.total} />
          <Row label="Platform administrators" value={overview.users.admins} />
        </Panel>
      </section>

      <section className="overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">Plan mix</h2>
        </div>
        <ul className="divide-y">
          {overview.planMix.map((plan) => (
            <li
              key={plan.key}
              className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-2.5 text-sm"
            >
              <span>{plan.name}</span>
              <span className="tabular-figures text-muted-foreground">
                {formatCurrency(plan.priceMinor / 100, {
                  compactZeroDecimals: true,
                })}
              </span>
              <span className="tabular-figures">
                {plan.tenants} {plan.tenants === 1 ? "business" : "businesses"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {NO_IMPERSONATION_NOTE}
      </p>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-xl border px-4 py-3.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular-figures mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <ul className="divide-y">{children}</ul>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-baseline justify-between gap-3 px-5 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-figures font-medium">{value}</span>
    </li>
  );
}
