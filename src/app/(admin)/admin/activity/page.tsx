import type { Metadata } from "next";
import { formatDateTime } from "@/lib/format";
import { listAdminActions } from "@/server/admin/admin-service";

export const metadata: Metadata = {
  title: "Admin activity",
  robots: { index: false, follow: false },
};

const READABLE: Record<string, string> = {
  "admin.company_status_changed": "changed a business's status",
  "admin.entitlement_override": "changed what a business can use",
  "admin.plan_updated": "changed a plan",
};

/**
 * What administrators have done.
 *
 * Read from the same append-only table the tenants' own actions go to. Nothing
 * on this page can be edited or removed, including by whoever is reading it:
 * administration that leaves no trace is indistinguishable from a breach
 * afterwards.
 */
export default async function AdminActivityPage() {
  const actions = await listAdminActions(100);

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">Administrative actions</h2>
        <p className="text-xs text-muted-foreground">
          Append-only. Nobody can edit or remove an entry here, including from
          this page.
        </p>
      </div>
      <ul className="divide-y">
        {actions.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-2.5 text-sm"
          >
            <span>
              <span className="font-medium">
                {entry.actorEmail ?? "somebody"}
              </span>{" "}
              <span className="text-muted-foreground">
                {READABLE[entry.action] ?? entry.action}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {entry.entityType}
              {entry.entityId ? ` ${entry.entityId.slice(0, 8)}` : ""}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatDateTime(entry.createdAt)}
            </span>
          </li>
        ))}
        {actions.length === 0 && (
          <li className="px-5 py-10 text-center text-sm text-muted-foreground">
            Nothing yet.
          </li>
        )}
      </ul>
    </div>
  );
}
