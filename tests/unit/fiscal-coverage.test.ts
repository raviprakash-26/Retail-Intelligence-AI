import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coversDay } from "../helpers/calendar";

/**
 * Whether a fiscal range covers a day.
 *
 * The suite used to answer this itself, in JavaScript, by comparing an
 * `@db.Date` column against `Date.now()`. A period ending on the 31st comes
 * back as midnight on the 31st, so from one second past midnight the comparison
 * said the period had already ended — and seventeen tests across three files
 * failed on the last day of the month, passed on the first, and had nothing to
 * do with the code they were testing.
 *
 * `findYearCovering` in the product does not have this problem, and says why:
 * Prisma sends a date parameter for a date column, so an afternoon timestamp
 * still lands inside a year ending that day. Its comment warns that "if it
 * stopped being true the calendar would decide the current year did not exist,
 * every year, on its last day" — which is exactly what the tests meant to pin
 * that behaviour were doing to themselves.
 *
 * These cases are pinned to fixed instants rather than to `new Date()`, so they
 * hold whatever day the suite is run on. That is the whole point: the defect
 * was only visible on twelve days a year.
 */

const august = { startDate: utc(2026, 8, 1), endDate: utc(2026, 8, 31) };

function utc(year: number, month: number, day: number, hour = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour));
}

describe("a period covers the whole of its last day", () => {
  it("covers the last day at midnight, which is how the column stores it", () => {
    expect(coversDay(august, utc(2026, 8, 31))).toBe(true);
  });

  it("covers the last day in the afternoon, which is when a suite runs", () => {
    // The case that failed. Every one of the seventeen was this.
    expect(coversDay(august, utc(2026, 8, 31, 14))).toBe(true);
  });

  it("covers the last second of the last day", () => {
    expect(coversDay(august, new Date(Date.UTC(2026, 7, 31, 23, 59, 59)))).toBe(
      true,
    );
  });

  it("covers the first day at any hour", () => {
    expect(coversDay(august, utc(2026, 8, 1))).toBe(true);
    expect(coversDay(august, utc(2026, 8, 1, 23))).toBe(true);
  });

  it("does not reach into the next month", () => {
    expect(coversDay(august, utc(2026, 9, 1))).toBe(false);
  });

  it("does not reach back into the previous one", () => {
    expect(coversDay(august, utc(2026, 7, 31, 23))).toBe(false);
  });

  it("holds for a February, and for a leap one", () => {
    const feb2026 = { startDate: utc(2026, 2, 1), endDate: utc(2026, 2, 28) };
    expect(coversDay(feb2026, utc(2026, 2, 28, 18))).toBe(true);
    expect(coversDay(feb2026, utc(2026, 3, 1))).toBe(false);

    const feb2028 = { startDate: utc(2028, 2, 1), endDate: utc(2028, 2, 29) };
    expect(coversDay(feb2028, utc(2028, 2, 29, 18))).toBe(true);
  });

  it("holds for a fiscal year ending on 31 March", () => {
    // The case `findYearCovering` names: "two in the afternoon on 31 March is
    // still inside a year ending 31 March".
    const year = { startDate: utc(2026, 4, 1), endDate: utc(2027, 3, 31) };
    expect(coversDay(year, utc(2027, 3, 31, 14))).toBe(true);
    expect(coversDay(year, utc(2027, 4, 1))).toBe(false);
  });
});

/**
 * Nothing in the suite answers this question on its own again.
 *
 * The six call sites were spelled the same way and the next one would be too.
 * The failure only shows on the last day of a month, so a regression would sit
 * unnoticed until CI happened to run on one — which is exactly the kind of
 * thing worth holding by reading the source.
 */
describe("no test compares a fiscal range against a timestamp itself", () => {
  it("has no call site left doing the comparison by hand", () => {
    const offenders = globSync("tests/**/*.ts", { cwd: process.cwd() })
      .filter((file) => !file.endsWith("helpers/calendar.ts"))
      .filter((file) =>
        /\b(startDate|endDate)\.getTime\(\)\s*(<=|>=)/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .sort();

    expect(offenders).toEqual([]);
  });
});
