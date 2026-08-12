"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Info, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RevenueChart } from "@/components/analytics/revenue-chart";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import { BAND_LABELS, HEALTH_DISCLAIMER } from "@/lib/analytics/health";
import { formatRatio, type Ratio } from "@/lib/analytics/ratios";
import { RANGE_KEYS, RANGE_LABELS } from "@/lib/analytics/range";
import type {
  AnalyticsReport,
  Movement,
} from "@/server/analytics/analytics-service";

/**
 * Analytics.
 *
 * Every figure here is arithmetic on entries that are already posted. Nothing
 * is predicted, nothing is modelled, and the totals reconcile with the profit
 * and loss account because they are read from the same engine — so the page can
 * be trusted against the statements rather than beside them.
 *
 * Where a comparison cannot be made honestly it is not made. Growth against a
 * period with no sales is not a large percentage, it is no percentage, and the
 * tiles say so instead of printing an infinity.
 */
export function AnalyticsView({ report }: { report: AnalyticsReport }) {
  const router = useRouter();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="text-muted-foreground">Period</span>
          <Select
            value={report.range}
            onValueChange={(next) => {
              router.push(`/app/analytics?range=${next}` as Route);
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  {RANGE_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="text-right text-xs text-muted-foreground">
          <p>
            {formatDate(report.from, { style: "short" })} to{" "}
            {formatDate(report.to, { style: "short" })}
          </p>
          <p>
            Compared with {formatDate(report.previousFrom, { style: "short" })}{" "}
            to {formatDate(report.previousTo, { style: "short" })}
          </p>
        </div>
      </div>

      {report.empty ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">
            Nothing was sold in this period
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Record a sale and this fills itself in. Nothing here is estimated,
            so an empty period stays empty rather than showing zeroes that look
            like findings.
          </p>
        </div>
      ) : (
        <Tabs defaultValue="overview">
          <div className="overflow-x-auto">
            <TabsList className="w-max">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="products">Products</TabsTrigger>
              <TabsTrigger value="customers">Customers</TabsTrigger>
              <TabsTrigger value="ratios">Ratios</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="pt-5">
            <OverviewPanel report={report} />
          </TabsContent>
          <TabsContent value="products" className="pt-5">
            <ProductsPanel report={report} />
          </TabsContent>
          <TabsContent value="customers" className="pt-5">
            <CustomersPanel report={report} />
          </TabsContent>
          <TabsContent value="ratios" className="pt-5">
            <RatiosPanel report={report} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewPanel({ report }: { report: AnalyticsReport }) {
  const busiest = [...report.weekdays].sort(
    (a, b) => Number(b.revenue) - Number(a.revenue),
  )[0];
  const peak = Math.max(
    ...report.weekdays.map((day) => Number(day.revenue)),
    0,
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MovementTile label="Revenue" movement={report.revenue} />
        <MovementTile label="Gross profit" movement={report.grossProfit} />
        <MovementTile label="Net profit" movement={report.netProfit} />
        <MovementTile label="Average bill" movement={report.averageBill} />
      </div>

      <Section
        title="Revenue and gross profit"
        subtitle={`${report.bills.current} bills over ${report.days} days · ${granularityWord(report.granularity)}`}
      >
        <RevenueChart trend={report.trend} granularity={report.granularity} />
        <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          Revenue here is the movement on your sales accounts, exactly as the
          profit and loss account defines it — so these bars add up to the
          revenue on your statements rather than to something close to it.
        </p>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="Which days earn"
          subtitle={
            busiest && Number(busiest.revenue) > 0
              ? `${busiest.label} is the strongest day in this period`
              : "No pattern yet"
          }
        >
          <div className="space-y-2.5 px-5 py-4">
            {report.weekdays.map((day) => (
              <div key={day.weekday} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {day.label.slice(0, 3)}
                </span>
                <Progress
                  value={peak > 0 ? (Number(day.revenue) / peak) * 100 : 0}
                  className="h-2"
                />
                <span className="tabular-figures w-24 shrink-0 text-right text-xs">
                  {formatCurrency(day.revenue)}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="What sells"
          subtitle={`${report.categories.length} ${report.categories.length === 1 ? "category" : "categories"}`}
        >
          {report.categories.length === 0 ? (
            <Empty>Nothing was sold in this period.</Empty>
          ) : (
            <div className="space-y-2.5 px-5 py-4">
              {report.categories.slice(0, 8).map((category) => (
                <div
                  key={category.categoryId ?? category.name}
                  className="flex items-center gap-3"
                >
                  <span className="w-28 shrink-0 truncate text-xs">
                    {category.name}
                  </span>
                  <Progress value={category.sharePercent} className="h-2" />
                  <span className="tabular-figures w-24 shrink-0 text-right text-xs">
                    {formatCurrency(category.revenue)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function granularityWord(granularity: AnalyticsReport["granularity"]): string {
  return granularity === "day"
    ? "by day"
    : granularity === "week"
      ? "by week"
      : "by month";
}

function MovementTile({
  label,
  movement,
}: {
  label: string;
  movement: Movement;
}) {
  const change = Number(movement.change);
  const up = change > 0;
  const flat = change === 0;

  return (
    <div className="rounded-xl border px-5 py-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular-figures mt-1 text-xl font-semibold">
        {formatCurrency(movement.current)}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-xs">
        {flat ? (
          <Minus className="size-3.5 text-muted-foreground" />
        ) : up ? (
          <TrendingUp className="size-3.5 text-success-foreground" />
        ) : (
          <TrendingDown className="size-3.5 text-destructive" />
        )}
        <span className="text-muted-foreground">
          {movement.changePercent === null ? (
            // Growth against a period with nothing in it is not a percentage.
            <>no comparison — nothing in the period before</>
          ) : (
            <>
              {up ? "+" : ""}
              {movement.changePercent.toFixed(1)}% on{" "}
              {formatCurrency(movement.previous)}
            </>
          )}
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

function ProductsPanel({ report }: { report: AnalyticsReport }) {
  const byRevenue = report.products;
  const byProfit = [...report.products].sort(
    (a, b) => Number(b.grossProfit) - Number(a.grossProfit),
  );
  const topRevenue = byRevenue[0];
  const topProfit = byProfit[0];
  const differ =
    topRevenue && topProfit && topRevenue.productId !== topProfit.productId;

  return (
    <div className="space-y-4">
      {differ && (
        <div className="rounded-xl border px-5 py-4">
          <p className="text-sm font-medium">
            The biggest seller is not the biggest earner
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {topRevenue.name} brought in the most money at{" "}
            {formatCurrency(topRevenue.revenue)}, but {topProfit.name} kept the
            most of it — {formatCurrency(topProfit.grossProfit)} of gross profit
            against {formatCurrency(topRevenue.grossProfit)}. Both facts are
            true; which one matters is a question about what you are trying to
            do.
          </p>
        </div>
      )}

      <Section
        title="Every product sold"
        subtitle="From the invoice lines, at the cost captured when each sale posted"
      >
        {byRevenue.length === 0 ? (
          <Empty>Nothing was sold in this period.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table className="border-0">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Product</TableHead>
                  <TableHead className="text-right">Sold</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Gross profit</TableHead>
                  <TableHead className="pr-5 text-right">Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byRevenue.map((product) => (
                  <TableRow key={product.productId}>
                    <TableCell className="pl-5 text-sm">
                      {product.name}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {product.sku}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-figures text-right text-sm">
                      {formatNumber(product.quantity)}
                    </TableCell>
                    <Amount value={product.revenue} />
                    <Amount value={product.cost} />
                    <Amount value={product.grossProfit} />
                    <TableCell className="tabular-figures pr-5 text-right text-sm">
                      {product.marginPercent === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        `${product.marginPercent.toFixed(1)}%`
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Note>
        These come from the invoice lines rather than from the ledger, because
        the ledger does not know about products. Where a discount or a manual
        entry was posted straight to an account, the total here can differ
        slightly from the revenue on the overview — which reads the ledger.
      </Note>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

function CustomersPanel({ report }: { report: AnalyticsReport }) {
  const { concentration } = report;

  return (
    <div className="space-y-4">
      {concentration.note && (
        <div className="rounded-xl border px-5 py-4">
          <p className="text-sm font-medium">One name carries a lot of this</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {concentration.note} That is a fact about the period, not a verdict
            — whether it is a risk depends on the relationship, which this
            cannot see.
          </p>
        </div>
      )}

      <Section
        title="Who bought"
        subtitle={
          concentration.topFiveSharePercent === null
            ? "Nothing sold in this period"
            : `The largest five are ${concentration.topFiveSharePercent.toFixed(1)}% of sales`
        }
      >
        {report.customers.length === 0 ? (
          <Empty>Nothing was sold in this period.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table className="border-0">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Customer</TableHead>
                  <TableHead className="text-right">Bills</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="pr-5 text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.customers.map((customer) => (
                  <TableRow key={customer.customerId ?? customer.name}>
                    <TableCell className="pl-5 text-sm">
                      {customer.name}
                    </TableCell>
                    <TableCell className="tabular-figures text-right text-sm">
                      {customer.bills}
                    </TableCell>
                    <Amount value={customer.revenue} />
                    <TableCell className="tabular-figures pr-5 text-right text-sm">
                      {customer.sharePercent.toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ratios and health
// ---------------------------------------------------------------------------

function RatiosPanel({ report }: { report: AnalyticsReport }) {
  const { health } = report;

  return (
    <div className="space-y-4">
      <Section
        title="How the business is holding up"
        subtitle={
          health.score === null
            ? "Not enough trading in this period"
            : `${health.score} out of 100 · ${health.band ? BAND_LABELS[health.band] : ""}`
        }
      >
        <div className="space-y-3 px-5 py-4">
          {health.score === null ? (
            <p className="text-sm text-muted-foreground">
              {health.unavailable}
            </p>
          ) : (
            <>
              <div className="flex items-baseline gap-3">
                <span className="tabular-figures text-3xl font-semibold">
                  {health.score}
                </span>
                <span className="text-sm text-muted-foreground">
                  out of 100
                </span>
                {health.band && (
                  <Badge variant="muted">{BAND_LABELS[health.band]}</Badge>
                )}
              </div>
              <dl className="space-y-2.5 pt-1">
                {health.components.map((component) => (
                  <div key={component.key} className="text-xs">
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="font-medium">
                        {component.label}
                        <span className="ml-1.5 text-muted-foreground">
                          {component.weight}%
                        </span>
                      </dt>
                      <dd className="tabular-figures">
                        {component.score === null ? (
                          <span className="text-muted-foreground">
                            not scored
                          </span>
                        ) : (
                          `${component.score} / 100`
                        )}
                      </dd>
                    </div>
                    <p className="mt-0.5 leading-relaxed text-muted-foreground">
                      {component.rule} Observed: {component.observed}.
                    </p>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
        <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          {HEALTH_DISCLAIMER}
        </p>
      </Section>

      <div className="grid gap-3 sm:grid-cols-2">
        {report.ratios.map((ratio) => (
          <RatioCard key={ratio.key} ratio={ratio} />
        ))}
      </div>

      <Note>
        Every ratio here is computed from posted entries by the same engine the
        statements read. A ratio that cannot be worked out honestly shows the
        reason rather than a zero, because on a dashboard a zero and &ldquo;we
        cannot tell&rdquo; look identical and mean opposite things.
      </Note>
    </div>
  );
}

function RatioCard({ ratio }: { ratio: Ratio }) {
  return (
    <div className="rounded-xl border px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{ratio.label}</p>
        <p className="tabular-figures text-lg font-semibold">
          {formatRatio(ratio)}
        </p>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {ratio.value === null ? ratio.unavailable : ratio.meaning}
      </p>
      {ratio.concern && (
        <p className="mt-2 text-xs leading-relaxed text-warning-foreground">
          {ratio.concern}
        </p>
      )}
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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
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
