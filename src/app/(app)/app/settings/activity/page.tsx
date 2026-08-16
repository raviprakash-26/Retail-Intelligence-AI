import type { Metadata } from "next";
import { ActivityLog } from "@/components/settings/activity-log";
import { requirePermission } from "@/server/auth/context";
import { listActivity } from "@/server/audit/audit-log-queries";

export const metadata: Metadata = {
  title: "Activity",
  robots: { index: false, follow: false },
};

/**
 * What has been done in this business, and by whom.
 *
 * The log has been written to from thirty-three places since the beginning and
 * read from none. Several things elsewhere in this product justify themselves
 * by pointing at it — the data export records who took a copy, a reopened
 * period records why — and those justifications were only half-true while
 * nothing could read it back.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("auditlog.view");
  const params = await searchParams;

  const one = (key: string) => {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value?.trim() || undefined;
  };

  const page = await listActivity({
    companyId: context.company.id,
    module: one("module"),
    actor: one("actor"),
    cursor: one("cursor"),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Activity</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Everything done in this business, newest first. Nothing here can be
          edited or removed — the record refuses changes at the database itself,
          which is what makes it worth reading when somebody needs to know who
          did something and when.
        </p>
      </div>

      <ActivityLog
        entries={page.entries}
        modules={page.modules}
        nextCursor={page.nextCursor}
        filter={{ module: one("module"), actor: one("actor") }}
      />
    </div>
  );
}
