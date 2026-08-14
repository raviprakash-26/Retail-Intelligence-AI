import type { Metadata } from "next";
import Link from "next/link";
import { CompanyStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { TenantSearch } from "@/components/admin/tenant-search";
import { listTenants } from "@/server/admin/admin-service";

export const metadata: Metadata = {
  title: "Businesses",
  robots: { index: false, follow: false },
};

const STATUS_VARIANT: Record<string, "muted" | "warning"> = {
  ACTIVE: "muted",
  ONBOARDING: "muted",
  SUSPENDED: "warning",
  CANCELLED: "warning",
};

function statusFrom(value: string | undefined): CompanyStatus | undefined {
  return value && value in CompanyStatus
    ? CompanyStatus[value as keyof typeof CompanyStatus]
    : undefined;
}

/**
 * Every business on the platform.
 *
 * Name, plan, how many people use it, how many entries were made this month.
 * There is no column here that could carry a rupee of anybody's trade.
 */
export default async function AdminTenantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const list = await listTenants({
    query: single("q"),
    status: statusFrom(single("status")),
    page: Number(single("page") ?? 1) || 1,
  });

  return (
    <div className="space-y-4">
      <TenantSearch
        query={single("q") ?? ""}
        status={single("status") ?? ""}
        total={list.total}
      />

      <div className="overflow-hidden rounded-xl border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-2.5 font-medium">Business</th>
                <th className="px-4 py-2.5 font-medium">Plan</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">People</th>
                <th className="px-4 py-2.5 text-right font-medium">
                  Entries this month
                </th>
                <th className="px-4 py-2.5 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/tenants/${row.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.isDemo && (
                      <Badge variant="muted" className="ml-2">
                        demo
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {row.planName ?? "—"}
                    {row.subscriptionStatus && (
                      <span className="ml-1.5 text-xs">
                        ({row.subscriptionStatus.toLowerCase()})
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={STATUS_VARIANT[row.status] ?? "muted"}>
                      {row.status.toLowerCase()}
                    </Badge>
                  </td>
                  <td className="tabular-figures px-4 py-2.5 text-right">
                    {row.users}
                  </td>
                  <td className="tabular-figures px-4 py-2.5 text-right">
                    {row.entriesThisMonth}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {formatDate(row.createdAt)}
                  </td>
                </tr>
              ))}
              {list.rows.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-muted-foreground"
                  >
                    Nothing matched.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {list.pageCount > 1 && (
        <p className="text-xs text-muted-foreground">
          Page {list.page} of {list.pageCount}
        </p>
      )}
    </div>
  );
}
