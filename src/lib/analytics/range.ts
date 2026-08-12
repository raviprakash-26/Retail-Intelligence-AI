/**
 * The periods analytics can be read over.
 *
 * Lives in `lib` rather than beside the service because the period picker is a
 * client control and the service is `server-only`. A label imported from the
 * server module would drag the whole query layer — Prisma included — into the
 * browser bundle, which is exactly what `server-only` exists to stop.
 */

export type RangeKey = "fy" | "90d" | "30d";

export const RANGE_LABELS: Record<RangeKey, string> = {
  fy: "This financial year",
  "90d": "Last 90 days",
  "30d": "Last 30 days",
};

export const RANGE_KEYS = Object.keys(RANGE_LABELS) as RangeKey[];

export function isRangeKey(value: string | undefined): value is RangeKey {
  return value !== undefined && value in RANGE_LABELS;
}
