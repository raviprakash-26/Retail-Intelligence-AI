"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ForecastChart } from "@/components/forecast/forecast-chart";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ForecastReport } from "@/server/forecast/forecast-service";

/**
 * Forecasting.
 *
 * The page leads with a range and never with a figure. Where a projection has a
 * middle it is shown thin, dashed and second, because the range is the answer —
 * "revenue will be ₹5,42,300" is a sentence no honest arithmetic produces, and
 * putting it in large type invites decisions the numbers do not support.
 *
 * Two panels, two different kinds of claim, and the difference is stated rather
 * than blurred: revenue is a line fitted through recorded weeks, and cash is a
 * roll-forward of commitments that already exist.
 */
export function ForecastView({ report }: { report: ForecastReport }) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="size-4" />
          Ranges, not predictions
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Nothing on this page knows what will happen. The revenue panel fits a
          line through the weeks you have already recorded and draws a band from
          how far those weeks fell from it; the cash panel adds up money already
          invoiced and already owed. Both are arithmetic on your own books, and
          both can be wrong in the ordinary way that arithmetic about the future
          is wrong.
        </p>
      </div>

      <Tabs defaultValue="cash">
        <div className="overflow-x-auto">
          <TabsList className="w-max">
            <TabsTrigger value="cash">Cash</TabsTrigger>
            <TabsTrigger value="revenue">Revenue</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="cash" className="pt-5">
          <CashPanel report={report} />
        </TabsContent>
        <TabsContent value="revenue" className="pt-5">
          <RevenuePanel report={report} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------

function CashPanel({ report }: { report: ForecastReport }) {
  const { cash } = report;
  const overdue = Number(cash.overdueReceivables) > 0;

  return (
    <div className="space-y-4">
      {cash.firstShortfall ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="size-4" />
            Cash runs short in the week of{" "}
            {formatDate(cash.firstShortfall.start, { style: "medium" })}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-destructive">
            On what is already committed, that week closes at{" "}
            {formatCurrency(cash.firstShortfall.amount)}. This counts no sales
            you have not yet made, so it is a floor rather than a prediction —
            but the commitments behind it are real.
          </p>
        </div>
      ) : cash.firstShortfallIfLate ? (
        <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4" />
            Cash holds if customers pay on time, and not if they pay as they
            have been
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Shifting every invoice by the {cash.latenessDays} days customers
            have actually been taking puts the week of{" "}
            {formatDate(cash.firstShortfallIfLate.start, { style: "medium" })}{" "}
            at {formatCurrency(cash.firstShortfallIfLate.amount)}. The gap
            between the two lines is what slow collection costs.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-xl border px-5 py-4">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" />
          <p className="text-sm leading-relaxed">
            On what is already committed, cash stays above nil for the whole of
            the next {report.horizonWeeks} weeks — on both lines. That is what
            the commitments say, not a promise about trading.
          </p>
        </div>
      )}

      <Section
        title={`The next ${report.horizonWeeks} weeks`}
        subtitle={`Opening at ${formatCurrency(cash.openingCash)} · ${formatCurrency(cash.weeklyRunningCost)} a week to run`}
      >
        <div className="overflow-x-auto">
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Week from</TableHead>
                <TableHead className="text-right">Due in</TableHead>
                <TableHead className="text-right">Due out</TableHead>
                <TableHead className="text-right">Running costs</TableHead>
                <TableHead className="text-right">Closing</TableHead>
                <TableHead className="pr-5 text-right">
                  If they pay late
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cash.weeks.map((week) => (
                <TableRow key={week.start}>
                  <TableCell className="pl-5 text-sm">
                    {formatDate(week.start, { style: "short" })}
                  </TableCell>
                  <Amount value={week.receiptsDue} />
                  <Amount value={week.paymentsDue} />
                  <Amount value={week.runningCosts} />
                  <TableCell
                    className={`tabular-figures text-right text-sm font-medium ${
                      week.negative ? "text-destructive" : ""
                    }`}
                  >
                    {formatCurrency(week.closingCash)}
                  </TableCell>
                  <TableCell
                    className={`tabular-figures pr-5 text-right text-sm ${
                      Number(week.closingCashIfLate) < 0
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                  >
                    {formatCurrency(week.closingCashIfLate)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          {cash.latenessBasis} {cash.runningCostBasis}
        </p>
      </Section>

      {overdue && (
        <Section
          title="Already past due"
          subtitle="Counted in the first week, because it is owed now"
        >
          <dl className="divide-y">
            <Line
              label="Customers owe you, past the due date"
              value={cash.overdueReceivables}
            />
            <Line
              label="You owe suppliers, past the due date"
              value={cash.overduePayables}
            />
          </dl>
        </Section>
      )}

      {cash.limitations.map((limitation) => (
        <Note key={limitation}>{limitation}</Note>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

function RevenuePanel({ report }: { report: ForecastReport }) {
  const { revenue } = report;

  if (revenue.unavailable) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-dashed px-6 py-12 text-center">
          <h3 className="text-base font-semibold">Not enough history yet</h3>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            {revenue.unavailable}
          </p>
        </div>
        {revenue.limitations.map((limitation) => (
          <Note key={limitation}>{limitation}</Note>
        ))}
      </div>
    );
  }

  const first = revenue.points[0];
  const last = revenue.points[revenue.points.length - 1];

  return (
    <div className="space-y-4">
      {revenue.tooUncertain && (
        <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4" />
            Your weeks vary too much to narrow this down
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            The range below is wider than the figure inside it. Read the range
            as the answer and treat the middle of it as meaningless — a single
            number here would be invented, not computed.
          </p>
        </div>
      )}

      <Section
        title="Revenue over the next weeks"
        subtitle={`${revenue.observations} weeks of history · band covers ${Math.round(revenue.level * 100)}% of weeks like these`}
      >
        <ForecastChart
          history={revenue.history}
          points={revenue.points}
          level={revenue.level}
        />
        <div className="border-t px-5 py-3.5">
          {first && last && (
            <p className="text-sm leading-relaxed">
              Next week looks like{" "}
              <span className="font-semibold">
                {formatCurrency(first.lower)} to {formatCurrency(first.upper)}
              </span>
              ; by the week of {formatDate(last.start, { style: "medium" })} the
              range is{" "}
              <span className="font-semibold">
                {formatCurrency(last.lower)} to {formatCurrency(last.upper)}
              </span>{" "}
              — wider, because further out is less knowable.
            </p>
          )}
          {revenue.direction && (
            <p className="mt-1 text-xs text-muted-foreground">
              {revenue.direction}
            </p>
          )}
        </div>
      </Section>

      <Section
        title="Week by week"
        subtitle="The range each week, and the middle of it"
      >
        <div className="overflow-x-auto">
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Week from</TableHead>
                <TableHead className="text-right">As low as</TableHead>
                <TableHead className="text-right">As high as</TableHead>
                <TableHead className="pr-5 text-right">
                  Middle of the range
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {revenue.points.map((point) => (
                <TableRow key={point.start}>
                  <TableCell className="pl-5 text-sm">
                    {formatDate(point.start, { style: "short" })}
                  </TableCell>
                  <Amount value={point.lower} />
                  <Amount value={point.upper} />
                  <TableCell className="tabular-figures pr-5 text-right text-sm text-muted-foreground">
                    {formatCurrency(point.point)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          {revenue.explanation} The method is{" "}
          <Badge variant="muted">{revenue.method}</Badge> — deterministic
          arithmetic, not a model&rsquo;s opinion.
        </p>
      </Section>

      {revenue.limitations.map((limitation) => (
        <Note key={limitation}>{limitation}</Note>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Amount({ value }: { value: string }) {
  return (
    <TableCell className="tabular-figures text-right text-sm">
      {Number(value) === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        formatCurrency(value)
      )}
    </TableCell>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3">
      <dt className="text-sm">{label}</dt>
      <dd className="tabular-figures text-sm font-medium">
        {formatCurrency(value)}
      </dd>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="border-b px-5 py-3.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
