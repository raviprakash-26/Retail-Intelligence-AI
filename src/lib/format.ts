import { publicEnv } from "@/lib/env";
import { money, round2, toNumber, type MoneyInput } from "@/lib/money";

/**
 * Presentation helpers. These are display-only — never round-trip a formatted
 * string back into a calculation.
 */

const DEFAULT_LOCALE = publicEnv.defaultLocale;
const DEFAULT_CURRENCY = publicEnv.defaultCurrency;

type CurrencyOptions = {
  locale?: string;
  currency?: string;
  /** Hide the ₹ symbol — for table columns with a currency in the header. */
  withoutSymbol?: boolean;
  /** Drop the paisa when the amount is a whole rupee. */
  compactZeroDecimals?: boolean;
};

export function formatCurrency(
  value: MoneyInput,
  options: CurrencyOptions = {},
): string {
  const {
    locale = DEFAULT_LOCALE,
    currency = DEFAULT_CURRENCY,
    withoutSymbol = false,
    compactZeroDecimals = false,
  } = options;

  const amount = round2(value);
  const fractionDigits =
    compactZeroDecimals && amount.modulo(1).isZero() ? 0 : 2;

  return new Intl.NumberFormat(locale, {
    style: withoutSymbol ? "decimal" : "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(toNumber(amount));
}

/**
 * Indian short-scale abbreviation used on KPI tiles where the exact paisa is
 * noise: ₹5.4L, ₹1.2Cr. The full figure always remains available on hover.
 */
export function formatCurrencyCompact(
  value: MoneyInput,
  options: { locale?: string; currency?: string } = {},
): string {
  const { locale = DEFAULT_LOCALE, currency = DEFAULT_CURRENCY } = options;
  const amount = money(value);
  const absolute = amount.abs();
  const sign = amount.isNegative() ? "-" : "";
  const symbol = currency === "INR" ? "₹" : "";

  const format = (divisor: number, suffix: string) =>
    `${sign}${symbol}${amount.abs().dividedBy(divisor).toDecimalPlaces(2).toString()}${suffix}`;

  if (currency === "INR") {
    if (absolute.greaterThanOrEqualTo(10_000_000))
      return format(10_000_000, "Cr");
    if (absolute.greaterThanOrEqualTo(100_000)) return format(100_000, "L");
    if (absolute.greaterThanOrEqualTo(1_000)) return format(1_000, "K");
    return formatCurrency(amount, {
      locale,
      currency,
      compactZeroDecimals: true,
    });
  }

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(toNumber(amount));
}

export function formatNumber(
  value: MoneyInput,
  options: { locale?: string; maximumFractionDigits?: number } = {},
): string {
  const { locale = DEFAULT_LOCALE, maximumFractionDigits = 3 } = options;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
  }).format(toNumber(value));
}

export function formatPercent(
  value: MoneyInput,
  options: {
    locale?: string;
    fractionDigits?: number;
    withSign?: boolean;
  } = {},
): string {
  const {
    locale = DEFAULT_LOCALE,
    fractionDigits = 1,
    withSign = false,
  } = options;
  const amount = money(value);
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(toNumber(amount));

  const sign = withSign && amount.greaterThan(0) ? "+" : "";
  return `${sign}${formatted}%`;
}

/** Indian convention: 09 Aug 2026. */
export function formatDate(
  value: Date | string | null | undefined,
  options: { locale?: string; style?: "short" | "medium" | "long" } = {},
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  const { locale = DEFAULT_LOCALE, style = "medium" } = options;
  const config: Intl.DateTimeFormatOptions =
    style === "short"
      ? { day: "2-digit", month: "2-digit", year: "numeric" }
      : style === "long"
        ? { day: "2-digit", month: "long", year: "numeric" }
        : { day: "2-digit", month: "short", year: "numeric" };

  return new Intl.DateTimeFormat(locale, config).format(date);
}

export function formatDateTime(
  value: Date | string | null | undefined,
  options: { locale?: string } = {},
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat(options.locale ?? DEFAULT_LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** "3 days ago", "in 2 months" — for activity feeds and due-date chips. */
export function formatRelativeTime(
  value: Date | string | null | undefined,
  options: { locale?: string; now?: Date } = {},
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  const now = options.now ?? new Date();
  const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(
    options.locale ?? DEFAULT_LOCALE,
    {
      numeric: "auto",
    },
  );

  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.34524],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];

  let duration = diffSeconds;
  for (const [unit, amount] of divisions) {
    if (Math.abs(duration) < amount) {
      return formatter.format(Math.round(duration), unit);
    }
    duration /= amount;
  }
  return formatter.format(Math.round(duration), "year");
}

/** Mask all but the last four characters of an account/card number. */
export function maskIdentifier(value: string | null | undefined): string {
  if (!value) return "—";
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return `${"•".repeat(Math.min(trimmed.length - 4, 8))}${trimmed.slice(-4)}`;
}

export function initialsOf(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}
