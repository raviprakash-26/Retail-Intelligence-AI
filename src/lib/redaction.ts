/**
 * Stripping secrets out of anything that gets written down.
 *
 * The audit log needed this first, and the structured logger needs exactly the
 * same rule for exactly the same reason — a password or a session token that
 * reaches durable storage is a leak whether the destination is a database table
 * or a log aggregator, and two lists of sensitive key names would drift the
 * moment somebody added one to only the first.
 *
 * Matching on the key rather than sniffing the value is deliberate. A rule that
 * tried to recognise "this looks like a token" fails open on the one shaped
 * unusually, which is the only case that matters; a rule that redacts anything
 * *called* a token cannot.
 */

export const REDACTED_KEYS =
  /^(password|newPassword|confirmPassword|passwordHash|token|tokenHash|secret|apiKey|authorization|cookie|sessionToken)$/i;

/** How deep to walk before giving up, so a cyclic object cannot hang a writer. */
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

export type JsonSafe =
  string | number | boolean | null | JsonSafe[] | { [key: string]: JsonSafe };

/** Recursively strips sensitive values and bounds the size of what is kept. */
export function redactValue(value: unknown, depth = 0): JsonSafe {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY)
      .map((item) => redactValue(item, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    const result: Record<string, JsonSafe> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[key] = REDACTED_KEYS.test(key)
        ? "[redacted]"
        : redactValue(item, depth + 1);
    }
    return result;
  }

  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}
