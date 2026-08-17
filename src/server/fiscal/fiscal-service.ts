import "server-only";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { FISCAL_YEAR_COOKIE } from "@/lib/constants/cookies";

export { FISCAL_YEAR_COOKIE };

/**
 * Fiscal years and periods.
 *
 * The year a person picks in the header scopes the reports that are read a year
 * at a time. It is held in a cookie rather than a URL parameter so it survives
 * navigation, and it is always validated against the company's own years — a
 * cookie is client data, and an id from one tenant must never resolve inside
 * another.
 *
 * Reading that cookie is `selectedFiscalYear`'s job and nothing else's. Four
 * pages used to read it themselves and pass it down, and the pages that did not
 * — the financial statements, the whole report catalogue, the tax working paper
 * — silently used the *current* year instead. The header said 2025-26 and the
 * statements underneath it were this year's. Nobody could see it while a tenant
 * had only ever been given one fiscal year, since the only id the cookie could
 * hold was also the current one; the calendar rolling over is what made the two
 * different.
 */

export type FiscalYearOption = {
  id: string;
  label: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
  isClosed: boolean;
};

export async function listFiscalYears(
  companyId: string,
): Promise<FiscalYearOption[]> {
  const years = await prisma.fiscalYear.findMany({
    where: { companyId },
    select: {
      id: true,
      label: true,
      startDate: true,
      endDate: true,
      isCurrent: true,
      closedAt: true,
    },
    orderBy: { startDate: "desc" },
  });

  return years.map((year) => ({
    id: year.id,
    label: year.label,
    startDate: year.startDate,
    endDate: year.endDate,
    isCurrent: year.isCurrent,
    isClosed: year.closedAt !== null,
  }));
}

/**
 * The year the person is looking at. This is what a page wants.
 *
 * `resolveFiscalYear` below takes an id and validates it; this finds the id
 * first, from the header's cookie, so that switching the year in the header
 * switches what the page shows.
 *
 * `requestedId` is for a page carrying its own year control in the URL — the
 * tax working paper does — and it wins, because a link somebody followed is a
 * more specific request than a cookie they set once.
 */
export async function selectedFiscalYear(
  companyId: string,
  requestedId?: string | null,
): Promise<FiscalYearOption | null> {
  const cookieStore = await cookies();
  return resolveFiscalYear(
    companyId,
    requestedId ?? cookieStore.get(FISCAL_YEAR_COOKIE)?.value ?? null,
  );
}

/**
 * Resolves the fiscal year to work in, given an id from somewhere.
 *
 * That id is client data wherever it came from — a cookie, a query string — so
 * it is treated as a suggestion: it is only honoured if it belongs to this
 * company. Anything else falls back to the current year, then to the most
 * recent.
 */
export async function resolveFiscalYear(
  companyId: string,
  requestedId?: string | null,
): Promise<FiscalYearOption | null> {
  const years = await listFiscalYears(companyId);
  if (years.length === 0) return null;

  if (requestedId) {
    const requested = years.find((year) => year.id === requestedId);
    if (requested) return requested;
  }

  return years.find((year) => year.isCurrent) ?? years[0] ?? null;
}

export type PeriodSummary = {
  id: string;
  label: string;
  startDate: Date;
  endDate: Date;
  status: "OPEN" | "CLOSED" | "LOCKED";
  entryCount: number;
};

export async function listPeriods(
  companyId: string,
  fiscalYearId: string,
): Promise<PeriodSummary[]> {
  const periods = await prisma.fiscalPeriod.findMany({
    where: { companyId, fiscalYearId },
    select: {
      id: true,
      label: true,
      startDate: true,
      endDate: true,
      status: true,
      _count: { select: { journalEntries: true } },
    },
    orderBy: { periodNumber: "asc" },
  });

  return periods.map((period) => ({
    id: period.id,
    label: period.label,
    startDate: period.startDate,
    endDate: period.endDate,
    status: period.status,
    entryCount: period._count.journalEntries,
  }));
}
