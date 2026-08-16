import "server-only";
import { FiscalPeriodStatus, JournalStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditLog } from "@/server/audit/audit-log";

/**
 * Closing the books on a period.
 *
 * The refusal to post into a closed period was written long before anything
 * could close one. `postJournalEntry` has always turned away an entry whose
 * period is not open, and the only way to reach that guard was to write
 * `status: 'CLOSED'` into the database by hand — which is what the integrity
 * test did. A correct guard nobody could arm.
 *
 * **What it is for.** Once a month's GST return has been filed, or a year has
 * been finalised with an accountant, the figures behind it must stop moving.
 * Without a close, nothing prevents a backdated invoice landing in a month
 * whose return was filed in July, and the return and the ledger then disagree
 * permanently — with the GST module happily rebuilding a different July next
 * time anybody looks. This is the other half of the principle the rest of the
 * codebase already follows: entries are reversed rather than edited, the
 * activity log is append-only, and figures do not quietly change after the
 * fact.
 *
 * **Closing is refused while anything is unfinished.** A draft invoice inside
 * the period is a document somebody intends to post; closing over it would
 * either strand it or force it into the next period, and both are worse than
 * being told to deal with it first.
 *
 * **Reopening is deliberately noisy.** It is a legitimate thing to need — a
 * mistake found after closing has to be correctable — but it means the figures
 * behind something already filed can change, so it demands a reason, and that
 * reason goes into the append-only log where an auditor will find it.
 *
 * **Nothing produces LOCKED yet, and that is on purpose.** The schema has a
 * third state meaning "closed and not reopenable". The posting guard already
 * treats it correctly, because anything other than OPEN is refused. What is
 * missing is a considered answer to what happens when somebody locks a year by
 * mistake, and shipping an irreversible button before having that answer would
 * be handing a shop a way to make its own books permanently uncorrectable.
 */

export class PeriodError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "ALREADY" | "PENDING" | "LOCKED" | "ORDER",
  ) {
    super(message);
    this.name = "PeriodError";
  }
}

export type PeriodView = {
  id: string;
  label: string;
  periodNumber: number;
  startDate: Date;
  endDate: Date;
  status: FiscalPeriodStatus;
  closedAt: Date | null;
  fiscalYearLabel: string;
  /** Posted entries inside it — what closing would be freezing. */
  postedEntries: number;
  /** Unfinished work that has to be dealt with before it can close. */
  pending: { journalDrafts: number };
  /** True where this period may be closed right now. */
  closable: boolean;
};

/** Every period of every year, newest first, with what closing would mean. */
export async function listPeriods(companyId: string): Promise<PeriodView[]> {
  const periods = await prisma.fiscalPeriod.findMany({
    where: { companyId },
    select: {
      id: true,
      label: true,
      periodNumber: true,
      startDate: true,
      endDate: true,
      status: true,
      closedAt: true,
      fiscalYear: { select: { label: true } },
    },
    orderBy: [{ startDate: "desc" }],
  });

  // Counted in two grouped queries rather than one per period: a company with
  // three years of history has thirty-six of them.
  const [posted, drafts] = await Promise.all([
    prisma.journalEntry.groupBy({
      by: ["fiscalPeriodId"],
      where: { companyId, status: JournalStatus.POSTED },
      _count: { _all: true },
    }),
    prisma.journalEntry.groupBy({
      by: ["fiscalPeriodId"],
      where: { companyId, status: JournalStatus.DRAFT },
      _count: { _all: true },
    }),
  ]);

  const postedBy = new Map(
    posted.map((row) => [row.fiscalPeriodId, row._count._all]),
  );
  const draftBy = new Map(
    drafts.map((row) => [row.fiscalPeriodId, row._count._all]),
  );

  return periods.map((period) => {
    const journalDrafts = draftBy.get(period.id) ?? 0;
    return {
      id: period.id,
      label: period.label,
      periodNumber: period.periodNumber,
      startDate: period.startDate,
      endDate: period.endDate,
      status: period.status,
      closedAt: period.closedAt,
      fiscalYearLabel: period.fiscalYear.label,
      postedEntries: postedBy.get(period.id) ?? 0,
      pending: { journalDrafts },
      closable:
        period.status === FiscalPeriodStatus.OPEN && journalDrafts === 0,
    };
  });
}

/**
 * Stops anything further being posted into a period.
 *
 * Earlier periods are required to be closed first. Books are closed in order
 * for the same reason they are kept in order: a closed March sitting behind an
 * open February says nothing useful about either, and somebody reading the year
 * cannot tell which figures are settled.
 */
export async function closePeriod(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  periodId: string;
  note?: string;
}): Promise<PeriodView> {
  const period = await prisma.fiscalPeriod.findFirst({
    where: { id: params.periodId, companyId: params.companyId },
    select: { id: true, label: true, status: true, startDate: true },
  });
  if (!period)
    throw new PeriodError("That period could not be found.", "NOT_FOUND");

  if (period.status !== FiscalPeriodStatus.OPEN) {
    throw new PeriodError(`${period.label} is already closed.`, "ALREADY");
  }

  const drafts = await prisma.journalEntry.count({
    where: {
      companyId: params.companyId,
      fiscalPeriodId: period.id,
      status: JournalStatus.DRAFT,
    },
  });
  if (drafts > 0) {
    throw new PeriodError(
      `${period.label} still has ${drafts} draft ${drafts === 1 ? "entry" : "entries"} in it. Post or discard them first — closing over a draft would strand it.`,
      "PENDING",
    );
  }

  const earlierOpen = await prisma.fiscalPeriod.findFirst({
    where: {
      companyId: params.companyId,
      startDate: { lt: period.startDate },
      status: FiscalPeriodStatus.OPEN,
    },
    select: { label: true },
    orderBy: { startDate: "asc" },
  });
  if (earlierOpen) {
    throw new PeriodError(
      `${earlierOpen.label} is still open, and it comes first. Close periods in order so the year reads as one thing.`,
      "ORDER",
    );
  }

  await prisma.fiscalPeriod.update({
    where: { id: period.id },
    data: { status: FiscalPeriodStatus.CLOSED, closedAt: new Date() },
  });

  await recordAuditLog({
    action: "fiscalPeriod.closed",
    module: "Accounting",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "FiscalPeriod",
    entityId: period.id,
    metadata: { period: period.label, note: params.note ?? null },
  });

  return (await find(params.companyId, period.id))!;
}

/**
 * Lets a closed period accept entries again.
 *
 * A reason is required rather than optional. Reopening means the figures
 * behind something that may already have been filed can change, and the person
 * who finds that six months later needs to know why it was done — so it is
 * written into the append-only log beside the close it undoes.
 */
export async function reopenPeriod(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  periodId: string;
  reason: string;
}): Promise<PeriodView> {
  const reason = params.reason.trim();
  if (reason.length < 4) {
    throw new PeriodError(
      "Say why this period is being reopened. It will be kept with the record.",
      "PENDING",
    );
  }

  const period = await prisma.fiscalPeriod.findFirst({
    where: { id: params.periodId, companyId: params.companyId },
    select: { id: true, label: true, status: true },
  });
  if (!period)
    throw new PeriodError("That period could not be found.", "NOT_FOUND");

  if (period.status === FiscalPeriodStatus.OPEN) {
    throw new PeriodError(`${period.label} is already open.`, "ALREADY");
  }
  if (period.status === FiscalPeriodStatus.LOCKED) {
    // Nothing produces this state yet; the check is here so that if anything
    // ever does, reopening is not the thing that quietly undoes it.
    throw new PeriodError(
      `${period.label} is locked and cannot be reopened.`,
      "LOCKED",
    );
  }

  await prisma.fiscalPeriod.update({
    where: { id: period.id },
    data: { status: FiscalPeriodStatus.OPEN, closedAt: null },
  });

  await recordAuditLog({
    action: "fiscalPeriod.reopened",
    module: "Accounting",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "FiscalPeriod",
    entityId: period.id,
    metadata: { period: period.label, reason },
  });

  return (await find(params.companyId, period.id))!;
}

async function find(
  companyId: string,
  periodId: string,
): Promise<PeriodView | null> {
  const all = await listPeriods(companyId);
  return all.find((period) => period.id === periodId) ?? null;
}
