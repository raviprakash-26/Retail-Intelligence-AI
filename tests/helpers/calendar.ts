/**
 * Does a fiscal range cover a day?
 *
 * `startDate` and `endDate` are `@db.Date` columns — days, stored at midnight —
 * and Prisma sends a date parameter when it queries them, which is why
 * `findYearCovering` can be handed an afternoon timestamp and still answer
 * correctly. Its own comment says why that matters: "if it stopped being true
 * the calendar would decide the current year did not exist, every year, on its
 * last day."
 *
 * The suite meant to pin that behaviour was doing the comparison itself, in
 * JavaScript, against `Date.now()`. A period ending on the 31st comes back as
 * midnight on the 31st, so from one second past midnight `endDate >= now` is
 * false and the test concluded no period covered today. Seventeen tests across
 * three files failed on the last day of the month, passed on the first, and
 * had nothing to do with the code they were testing.
 *
 * So the comparison is made where it belongs: on the calendar day, both sides
 * truncated the same way the database truncates them.
 */
export function coversDay(
  range: { startDate: Date; endDate: Date },
  at: Date,
): boolean {
  const day = utcDay(at);
  return utcDay(range.startDate) <= day && utcDay(range.endDate) >= day;
}

/** Midnight UTC on the calendar day a timestamp falls in. */
function utcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
