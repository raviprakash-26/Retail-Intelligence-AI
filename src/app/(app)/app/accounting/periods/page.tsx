import type { Metadata } from "next";
import { PeriodManager } from "@/components/accounting/period-manager";
import { requirePermission } from "@/server/auth/context";
import { listPeriods } from "@/server/accounting/period-service";

export const metadata: Metadata = {
  title: "Periods",
  robots: { index: false, follow: false },
};

/**
 * Which months are settled, and which are still moving.
 *
 * The refusal to post into a closed period was written long before anything
 * could close one. This page is what arms it.
 */
export default async function PeriodsPage() {
  const context = await requirePermission("accounting.view");
  const periods = await listPeriods(context.company.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Accounting periods</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Closing a period stops anything further being posted into it. Once a
          return has been filed or a year finalised, that is what keeps the
          figures behind it from moving — nothing else in this application
          prevents a backdated entry landing in a month you have already filed.
        </p>
      </div>

      {periods.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-6 text-center text-sm text-muted-foreground">
          No periods yet.
        </p>
      ) : (
        <PeriodManager
          periods={periods}
          canClose={context.permissions.has("accounting.period.close")}
        />
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Periods close in order, and a period holding a draft entry cannot close
        until the draft is posted or discarded — closing over one would strand
        it. Reopening asks for a reason and records it in the activity log.
      </p>
    </div>
  );
}
