"use client";

import * as React from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
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
import type { SerialisedForecastPoint } from "@/server/forecast/forecast-service";

/**
 * The weeks already recorded, and the band the projection sits in.
 *
 * The band is drawn as an area rather than a second line, because a range is
 * the answer here and a line through the middle of it is not. The point series
 * is still drawn inside the band — people need something to read — but it is
 * thin and dashed over the projected weeks, so the eye sees an area first and a
 * figure second.
 */
export function ForecastChart({
  history,
  points,
  level,
}: {
  history: SerialisedForecastPoint[];
  points: SerialisedForecastPoint[];
  level: number;
}) {
  const data = React.useMemo(() => {
    const past = history.map((entry) => ({
      start: entry.start,
      label: formatDate(entry.start, { style: "short" }).slice(0, 6),
      actual: Number(entry.point),
      band: null as [number, number] | null,
      projected: null as number | null,
    }));

    // The join: the last actual week also carries the first band point, so the
    // area starts where the history ends instead of floating away from it.
    const lastActual = past[past.length - 1];
    const future = points.map((entry, index) => ({
      start: entry.start,
      label: formatDate(entry.start, { style: "short" }).slice(0, 6),
      actual: null as number | null,
      band: [Number(entry.lower), Number(entry.upper)] as [number, number],
      projected: Number(entry.point),
      key: index,
    }));

    if (lastActual && future.length > 0) {
      lastActual.band = [lastActual.actual, lastActual.actual];
      (lastActual as { projected: number | null }).projected =
        lastActual.actual;
    }

    return [...past, ...future];
  }, [history, points]);

  if (data.length === 0) return null;

  const firstProjected = points[0]?.start;

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
            minTickGap={20}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={(value: number) => formatCurrencyCompact(value)}
          />
          <Tooltip
            cursor={{ stroke: "var(--chart-grid)" }}
            content={<ForecastTooltip level={level} />}
          />
          <Area
            dataKey="band"
            name="Range"
            stroke="none"
            fill="var(--chart-1)"
            fillOpacity={0.18}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            dataKey="actual"
            name="Recorded"
            type="monotone"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            dataKey="projected"
            name="Middle of the range"
            type="monotone"
            stroke="var(--chart-1)"
            strokeWidth={1}
            strokeDasharray="4 4"
            dot={false}
            connectNulls
          />
          {firstProjected && (
            <ReferenceLine
              x={formatDate(firstProjected, { style: "short" }).slice(0, 6)}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

type Row = {
  label: string;
  actual: number | null;
  band: [number, number] | null;
  projected: number | null;
};

function ForecastTooltip({
  active,
  payload,
  level,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Row }>;
  level?: number;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  const recorded = point.actual !== null;

  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-medium">{point.label}</p>
      {recorded ? (
        <p className="mt-1">
          Recorded{" "}
          <span className="tabular-figures font-medium">
            {formatCurrency(point.actual ?? 0)}
          </span>
        </p>
      ) : (
        <>
          <p className="mt-1">
            Somewhere between{" "}
            <span className="tabular-figures font-medium">
              {formatCurrency(point.band?.[0] ?? 0)}
            </span>{" "}
            and{" "}
            <span className="tabular-figures font-medium">
              {formatCurrency(point.band?.[1] ?? 0)}
            </span>
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {Math.round((level ?? 0.8) * 100)}% of the time, on this history
          </p>
        </>
      )}
    </div>
  );
}
