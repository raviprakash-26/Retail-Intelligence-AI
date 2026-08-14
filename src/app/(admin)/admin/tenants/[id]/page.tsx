import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { TenantControls } from "@/components/admin/tenant-controls";
import { formatDate, formatDateTime } from "@/lib/format";
import { NO_IMPERSONATION_NOTE } from "@/lib/admin/scope";
import { getTenantDetail, listPlans } from "@/server/admin/admin-service";

export const metadata: Metadata = {
  title: "Business",
  robots: { index: false, follow: false },
};

/**
 * One business, as the platform sees it.
 *
 * Which plan, who can sign in, how much they have entered, what has been
 * granted to them by hand. Not one line of their accounting.
 */
export default async function AdminTenantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [tenant, plans] = await Promise.all([getTenantDetail(id), listPlans()]);
  if (!tenant) notFound();

  const plan = plans.find((entry) => entry.key === tenant.planKey);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/tenants"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          ← All businesses
        </Link>
        <h1 className="mt-1.5 flex flex-wrap items-center gap-2.5 text-xl font-semibold">
          {tenant.name}
          <Badge variant={tenant.status === "ACTIVE" ? "muted" : "warning"}>
            {tenant.status.toLowerCase()}
          </Badge>
          {tenant.isDemo && <Badge variant="muted">demo</Badge>}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {tenant.slug} · joined {formatDate(tenant.createdAt)}
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-4">
        <Tile label="Plan" value={tenant.planName ?? "None"} />
        <Tile
          label="Subscription"
          value={tenant.subscriptionStatus?.toLowerCase() ?? "none"}
        />
        <Tile label="People" value={String(tenant.users)} />
        <Tile
          label="Entries this month"
          value={String(tenant.entriesThisMonth)}
        />
      </section>

      <section className="overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">Who can sign in</h2>
        </div>
        <ul className="divide-y">
          {tenant.members.map((member) => (
            <li
              key={member.id}
              className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-2.5 text-sm"
            >
              <span>
                {member.fullName}
                <span className="ml-2 text-xs text-muted-foreground">
                  {member.email}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {member.roleName} · {member.status.toLowerCase()}
              </span>
              <span className="text-xs text-muted-foreground">
                {member.lastSignInAt
                  ? `last in ${formatDateTime(member.lastSignInAt)}`
                  : "never signed in"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <TenantControls
        companyId={tenant.id}
        status={tenant.status}
        featureOverrides={tenant.featureOverrides}
        planFeatures={plan?.features ?? []}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">
        {NO_IMPERSONATION_NOTE}
      </p>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium capitalize">{value}</p>
    </div>
  );
}
