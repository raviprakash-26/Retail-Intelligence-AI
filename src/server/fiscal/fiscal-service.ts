import "server-only";
import { prisma } from "@/lib/db";

export { FISCAL_YEAR_COOKIE } from "@/lib/constants/cookies";

/**
 * Fiscal years and periods.
 *
 * The selected year scopes every report and listing in the application. It is
 * held in a cookie rather than a URL parameter so it survives navigation, and
 * it is always validated against the company's own years — a cookie is client
 * data, and an id from one tenant must never resolve inside another.
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
 * Resolves the fiscal year to work in.
 *
 * `requestedId` comes from a cookie, so it is treated as a suggestion: it is
 * only honoured if it belongs to this company. Anything else falls back to the
 * current year, then to the most recent.
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

