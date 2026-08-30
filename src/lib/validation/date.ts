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

/**
 * What day it is where the business is.
 *
 * The settings screen asks a shop for its time zone and says the answer
 * "decides which day a transaction recorded late at night belongs to". Nothing
 * read it. Every form defaulted its date to `new Date().toISOString()`, which
 * is the day in UTC — so for a shop in Asia/Kolkata, between midnight and half
 * past five in the morning, the date offered was **yesterday**. A kirana open
 * late bills the night's takings into the previous day, and on the first of a
 * month into the previous month's GST return, which may already have been
 * filed.
 *
 * `en-CA` is used only because it formats as `YYYY-MM-DD`; the locale is
 * otherwise irrelevant. `formatToParts` would say the same thing in more
 * lines.
 *
 * An unrecognised zone falls back to UTC rather than throwing. The stored value
 * is constrained to a known list, so this should be unreachable — but a date
 * helper that can throw is a date helper that can take down every form in the
 * product, and it is on the path of a shop simply opening the sales page.
 */
export function businessToday(timezone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
