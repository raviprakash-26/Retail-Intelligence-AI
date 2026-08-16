import "server-only";
import { prisma } from "@/lib/db";
import type { ActivityEntry } from "@/lib/audit/activity";

/**
 * Reading the activity log.
 *
 * Thirty-three places in this codebase write to this table and, until now,
 * nothing could read it. The log is append-only — a database trigger refuses
 * updates and deletes — it records twenty-two distinct actions, and the only
 * reader was the platform administrator's own view. A shop owner asking who
 * voided a forty-thousand-rupee invoice, who exported the entire customer
 * list, or who reopened March after the return was filed had no way to look,
 * even though the answer was sitting there immutably by design.
 *
 * That mattered more than an ordinary missing screen, because the log is the
 * justification for several things elsewhere: the data export says it is
 * recorded before the download starts, the reminder says when a customer was
 * last chased, reopening a period says the reason is kept where an auditor
 * will find it. All true, and none of it reachable.
 *
 * **A platform administrator's actions are shown, but not their name.** When
 * somebody at this platform changes a shop's plan or suspends its account, the
 * entry carries the shop's `companyId` and that administrator's own email
 * address. Hiding the act would be the product concealing what was done to a
 * customer; showing the email would hand a customer an internal person's
 * identity. So the act appears and the actor reads as "Platform
 * administration".
 */

/** How many entries one page holds. */
export const ACTIVITY_PAGE = 50;

export type { ActivityEntry };

export type ActivityPage = {
  entries: ActivityEntry[];
  /** The id to ask for the next page with, or null at the end. */
  nextCursor: string | null;
  /** Every module that has ever written for this company, for the filter. */
  modules: string[];
};

export type ActivityFilter = {
  companyId: string;
  module?: string;
  /** Matched against the actor's email, case-insensitively. */
  actor?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
};

/**
 * One page of activity, newest first.
 *
 * Cursor paging rather than offset: this is the fastest-growing table in the
 * schema, and `skip` on the ten-thousandth page makes the database count its
 * way there every time. No total is returned for the same reason — a count
 * over a table this size, on every page load, to render a number nobody acts
 * on.
 */
export async function listActivity(
  filter: ActivityFilter,
): Promise<ActivityPage> {
  const where = {
    // Never a bare `id` lookup and never an unscoped read: entries with no
    // company at all exist (a registration before the company does) and belong
    // to nobody's activity log.
    companyId: filter.companyId,
    ...(filter.module ? { module: filter.module } : {}),
    ...(filter.actor
      ? { actorEmail: { contains: filter.actor, mode: "insensitive" as const } }
      : {}),
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
  };

  const rows = await prisma.auditLog.findMany({
    where,
    select: {
      id: true,
      createdAt: true,
      actorEmail: true,
      action: true,
      module: true,
      entityType: true,
      entityId: true,
      metadata: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ACTIVITY_PAGE + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > ACTIVITY_PAGE;
  const page = hasMore ? rows.slice(0, ACTIVITY_PAGE) : rows;

  // Read once for the filter rather than hard-coded: a module added later
  // appears here without anybody remembering to list it.
  const modules = await prisma.auditLog.findMany({
    where: { companyId: filter.companyId },
    select: { module: true },
    distinct: ["module"],
    orderBy: { module: "asc" },
  });

  return {
    entries: page.map((row) => {
      const byPlatform = row.module === "ADMIN";
      return {
        id: row.id,
        at: row.createdAt,
        actor: byPlatform
          ? "Platform administration"
          : (row.actorEmail ?? "Unknown"),
        byPlatform,
        action: row.action,
        module: row.module,
        entityType: row.entityType,
        entityId: row.entityId,
        metadata: row.metadata,
      };
    }),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    modules: modules.map((row) => row.module),
  };
}
