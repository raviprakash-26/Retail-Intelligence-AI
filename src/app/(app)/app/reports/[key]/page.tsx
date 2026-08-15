import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PlanLocked } from "@/components/billing/plan-locked";
import { ReportControls } from "@/components/reports/report-controls";
import { ReportView } from "@/components/reports/report-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { requireCompanyContext } from "@/server/auth/context";
import { authorizeReport } from "@/server/reports/access";
import { resolveFiscalYear } from "@/server/fiscal/fiscal-service";
import {
  reportEntityOptions,
  runReport,
  ReportError,
} from "@/server/reports/report-service";

export const metadata: Metadata = {
  title: "Report",
  robots: { index: false, follow: false },
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * One report.
 *
 * The period defaults to the selected fiscal year, because that is the period
 * somebody asking for a profit figure means, and it is the same default the
 * statements page uses — two reports of the same business over silently
 * different windows is a good way to lose an afternoon.
 *
 * A refusal is rendered rather than thrown wherever it is something the reader
 * could act on. A plan gate offers the upgrade; a missing permission says so
 * plainly and stops. Neither leaks a figure on the way past.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requireCompanyContext();
  const { key } = await params;

  const access = await authorizeReport({ context, key });
  if (!access.allowed && access.reason === "unknown") notFound();

  const query = await searchParams;
  const single = (name: string): string | undefined => {
    const value = query[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const definition = access.definition!;
  const year = await resolveFiscalYear(context.company.id);
  const today = new Date();

  const from = single("from") ?? (year ? isoDay(year.startDate) : "2000-01-01");
  const to = single("to") ?? (year ? isoDay(year.endDate) : isoDay(today));
  const periodYear = Number(single("year") ?? today.getUTCFullYear());
  const periodMonth = Number(single("month") ?? today.getUTCMonth() + 1);
  const entityId = single("entity");

  // A ledger is the ledger *of* something, so the subject is offered before
  // the report is. Nothing is auto-selected: picking the first account
  // alphabetically and presenting its balances as an answer would be worse
  // than asking.
  const entityOptions = definition.entity
    ? await reportEntityOptions(context.company.id, definition.entity)
    : [];
  const entityLabel =
    definition.entity === "account"
      ? "Account"
      : definition.entity === "customer"
        ? "Customer"
        : "Supplier";
  const chosen = entityOptions.some((option) => option.id === entityId)
    ? entityId
    : undefined;

  const header = (
    <>
      <Link
        href="/app/reports"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline print:hidden"
      >
        <ArrowLeft className="size-3.5" />
        All reports
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">
        {definition.title}
      </h1>
    </>
  );

  if (!access.allowed) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        {header}
        <div className="mt-6">
          {access.reason === "feature" && definition.feature ? (
            <PlanLocked
              feature={definition.feature}
              planName={access.planName ?? "your current plan"}
              availableOn={access.availableOn}
            />
          ) : (
            <Alert variant="destructive">
              <AlertTitle>Not available to you</AlertTitle>
              <AlertDescription>{access.message}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    );
  }

  if (definition.entity && !chosen) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        {header}
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          {definition.description}
        </p>
        <ReportControls
          period={definition.period}
          resolved={{ from, to, year: periodYear, month: periodMonth }}
          entity={{
            label: entityLabel,
            selected: undefined,
            options: entityOptions,
          }}
          canExport={context.permissions.has("reports.export")}
        />
        <div className="mt-6 rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">
            Choose{" "}
            {entityLabel === "Account"
              ? "an account"
              : `a ${entityLabel.toLowerCase()}`}
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            {entityOptions.length === 0
              ? `There are no ${entityLabel.toLowerCase()}s on record yet.`
              : "This report is about one subject rather than the whole business, so there is nothing to show until you pick one."}
          </p>
        </div>
      </div>
    );
  }

  let report;
  try {
    report = await runReport({
      companyId: context.company.id,
      key: definition.key,
      period: {
        from,
        to,
        year: periodYear,
        month: periodMonth,
        entityId: chosen,
      },
    });
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        {header}
        <div className="mt-6">
          <Alert variant="destructive">
            <AlertTitle>That period does not work</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      {header}
      <p className="mt-1 text-sm text-muted-foreground">
        {context.company.name} · {report.period}
      </p>

      <div className="mt-6 space-y-6">
        <ReportControls
          period={definition.period}
          resolved={{ from, to, year: periodYear, month: periodMonth }}
          entity={
            definition.entity
              ? {
                  label: entityLabel,
                  selected: chosen,
                  options: entityOptions,
                }
              : undefined
          }
          canExport={context.permissions.has("reports.export")}
        />
        <ReportView report={report} />
      </div>
    </div>
  );
}
