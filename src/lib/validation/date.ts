import { z } from "zod";

/**
 * A calendar date, as `YYYY-MM-DD`.
 *
 * Shared by every schema that takes one, because the check is subtler than it
 * looks and having six copies of it meant six chances to get it wrong.
 *
 * `Date.parse` is not a validity check. It rolls impossible dates over rather
 * than rejecting them: `2026-02-30` parses happily and lands on 2 March, and a
 * schema that only asked whether parsing succeeded would accept it, post an
 * invoice dated 30 February, and file it in the wrong month. So the parsed date
 * is written back out and compared with what arrived — only a real date
 * survives the round trip.
 */
export const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) return false;
      return parsed.toISOString().slice(0, 10) === value;
    },
    { message: "That is not a real date." },
  );

/** Midnight UTC on the given day. Storage is date-only; the time is noise. */
export function toUtcDay(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
