"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { describeAction, type ActivityEntry } from "@/lib/audit/activity";

/**
 * What has been done in this business, and by whom.
 *
 * Read-only by construction — the table it comes from refuses updates and
 * deletes at the database — so there is nothing here to act on, only to look
 * at. What matters is that looking is possible at all: the log has been
 * written to from thirty-three places and read from none.
 *
 * The metadata each entry carries is shown rather than summarised. It is the
 * part that answers the question somebody came with — which period was
 * reopened and why, how many rows an import created, which customer was
 * reminded — and a friendly sentence that dropped it would send them back to
 * asking a developer.
 */
export function ActivityLog({
  entries,
  modules,
  nextCursor,
  filter,
}: {
  entries: ActivityEntry[];
  modules: string[];
  nextCursor: string | null;
  filter: { module?: string; actor?: string };
}) {
  const router = useRouter();
  const params = useSearchParams();

  function apply(next: Record<string, string | undefined>) {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) query.set(key, value);
      else query.delete(key);
    }
    // A new filter starts at the newest entry again; keeping the old cursor
    // would show page four of a list nobody has seen page one of.
    query.delete("cursor");
    router.push(`/app/settings/activity?${query.toString()}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={filter.module ? "outline" : "default"}
          size="sm"
          onClick={() => apply({ module: undefined })}
        >
          Everything
        </Button>
        {modules.map((module) => (
          <Button
            key={module}
            type="button"
            variant={filter.module === module ? "default" : "outline"}
            size="sm"
            onClick={() => apply({ module })}
          >
            {module}
          </Button>
        ))}
      </div>

      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-6 text-center text-sm text-muted-foreground">
          Nothing recorded here yet.
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {entries.map((entry) => (
            <li key={entry.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">
                  {describeAction(entry.action)}
                </p>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={new Date(entry.at).toISOString()}
                >
                  {formatDateTime(entry.at)}
                </time>
              </div>

              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="muted" className="text-[0.625rem]">
                  {entry.module}
                </Badge>
                {entry.byPlatform ? (
                  <span className="inline-flex items-center gap-1">
                    <ShieldAlert className="size-3" aria-hidden="true" />
                    {entry.actor}
                  </span>
                ) : (
                  entry.actor
                )}
              </p>

              {entry.metadata !== null && entry.metadata !== undefined && (
                <pre className="mt-1.5 overflow-x-auto rounded-lg bg-muted/50 px-2.5 py-1.5 text-[0.6875rem] leading-relaxed whitespace-pre-wrap">
                  {JSON.stringify(entry.metadata, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="text-center">
          <Button asChild variant="outline">
            <Link
              href={`/app/settings/activity?${new URLSearchParams({
                ...(filter.module ? { module: filter.module } : {}),
                ...(filter.actor ? { actor: filter.actor } : {}),
                cursor: nextCursor,
              }).toString()}`}
            >
              Older entries
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
