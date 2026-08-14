import type { Metadata } from "next";
import Link from "next/link";
import type { Route } from "next";
import { ArrowRight } from "lucide-react";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { visibleReports } from "@/lib/reports/catalogue";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Reports",
  robots: { index: false, follow: false },
};

/**
 * Every report the business can run, and nothing it cannot.
 *
 * The list is filtered by what this member may actually open rather than
 * greyed out. A locked door with a name on it tells somebody exactly what
 * their colleagues can see, which is information a role was meant to withhold.
 *
 * Each card names the module the figures come from. That is not decoration:
 * the whole claim of this module is that it reports what something else
 * computed, and a reader who wants to check a figure should know where to go
 * and argue with it.
 */
export default async function ReportsPage() {
  const context = await requirePermission("reports.view");
  const groups = visibleReports(context.permissions);
  const canExport = context.permissions.has("reports.export");

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Reports"
        description="Each one runs the service that owns the figures and prints what comes back — the trial balance report is the trial balance, not a second opinion about it. Every report can be printed, and exported as a CSV that carries the same numbers."
        aside={
          canExport ? undefined : (
            <div className="rounded-lg border px-4 py-2.5 text-sm text-muted-foreground">
              You can read reports but not export them.
            </div>
          )
        }
      />

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">No reports available</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            Reports draw on the modules you have access to, and your role does
            not currently include any of them.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.category}>
              <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
                {group.category}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.reports.map((report) => (
                  <Card
                    key={report.key}
                    className="transition-colors hover:border-foreground/20"
                  >
                    <CardContent className="py-4">
                      <Link
                        href={`/app/reports/${report.key}` as Route}
                        className="group block after:absolute after:inset-0"
                      >
                        <span className="flex items-center justify-between gap-2 font-medium">
                          {report.title}
                          <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                        </span>
                      </Link>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                        {report.description}
                      </p>
                      <Badge variant="muted" className="mt-3">
                        {report.source}
                      </Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
