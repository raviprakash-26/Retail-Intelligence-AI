"use client";

import * as React from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatCurrency,
  formatCurrencyCompact,
  formatDate,
} from "@/lib/format";
import type {
  Granularity,
  TrendPoint,
} from "@/server/analytics/sales-analytics";

/**
 * Revenue and gross profit over the period.
 *
 * Two series rather than one, because they answer different questions and
 * because the gap between them is the whole story: revenue that rises while
 * gross profit does not is a shop selling more and keeping less, which a
 * revenue line on its own hides completely.
 *
 * Colours come from the design tokens rather than from a palette of their own,
 * so the chart follows the theme into dark mode instead of glowing at the
 * reader.
 */
export function RevenueChart({
  trend,
  granularity,
}: {
  trend: TrendPoint[];
  granularity: Granularity;
}) {
  const data = React.useMemo(
    () =>
      trend.map((point) => ({
        start: point.start,
        label: bucketLabel(point.start, granularity),
        revenue: Number(point.revenue),
        grossProfit: Number(point.grossProfit),
        bills: point.bills,
      })),
    [trend, granularity],
  );

  if (data.length === 0) {
    return (
      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
        Nothing was sold in this period.
      </p>
    );
  }

  return (
    <div className="h-72 w-full px-2 py-4">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
        >
          <CartesianGrid
            stroke="var(--chart-grid)"
            strokeDasharray="3 3"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={(value: number) => formatCurrencyCompact(value)}
          />
          <Tooltip
            cursor={{ fill: "var(--secondary)" }}
            content={<ChartTooltip />}
          />
          <Bar
            dataKey="revenue"
            name="Revenue"
            fill="var(--chart-1)"
            radius={[3, 3, 0, 0]}
            maxBarSize={44}
          />
          <Line
            dataKey="grossProfit"
            name="Gross profit"
            type="monotone"
            stroke="var(--chart-5)"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

type TooltipPayload = {
  payload?: {
    label: string;
    revenue: number;
    grossProfit: number;
    bills: number;
  };
};

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-medium">{point.label}</p>
      <dl className="mt-1.5 space-y-0.5">
        <Row label="Revenue" value={formatCurrency(point.revenue)} />
        <Row label="Gross profit" value={formatCurrency(point.grossProfit)} />
        <Row label="Bills" value={String(point.bills)} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-figures font-medium">{value}</dd>
    </div>
  );
}

/**
 * What to call a bucket.
 *
 * A month bucket labelled with its first day reads as a day, so each
 * granularity gets the shortest label that is not ambiguous.
 */
export function bucketLabel(start: string, granularity: Granularity): string {
  const date = new Date(`${start}T00:00:00.000Z`);
  if (granularity === "month") {
    return date.toLocaleDateString("en-IN", {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });
  }
  if (granularity === "week") {
    return `w/c ${formatDate(start, { style: "short" }).slice(0, 6)}`;
  }
  return formatDate(start, { style: "short" }).slice(0, 6);
}
