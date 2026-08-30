import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  asBusinessTimezone,
  BUSINESS_TIMEZONES,
  companyAccountingSchema,
} from "@/lib/validation/company";
import { businessToday, toUtcDay } from "@/lib/validation/date";

/**
 * Which day the business is on.
 *
 * The settings screen tells a shop its time zone "decides which day a
 * transaction recorded late at night belongs to". Nothing read it: every form
 * defaulted to the day in UTC, so a shop in Asia/Kolkata billing at one in the
 * morning was offered yesterday's date — and on the first of a month, the
 * previous month's GST return.
 */

/** 01:15 on 30 August, as the clock reads in India. */
const lateNightInIndia = new Date("2026-08-30T01:15:00+05:30");

describe("businessToday", () => {
  it("gives the day the shop is living in, not the day in UTC", () => {
    expect(businessToday("Asia/Kolkata", lateNightInIndia)).toBe("2026-08-30");
    expect(lateNightInIndia.toISOString().slice(0, 10)).toBe("2026-08-29");
  });

  it("rolls the month with it", () => {
    // 00:30 on 1 September in Kolkata is still 31 August in UTC — the night a
    // sale would have landed in the previous month's return.
    const firstOfSeptember = new Date("2026-09-01T00:30:00+05:30");
    expect(businessToday("Asia/Kolkata", firstOfSeptember)).toBe("2026-09-01");
    expect(businessToday("UTC", firstOfSeptember)).toBe("2026-08-31");
  });

  it("answers for zones behind UTC as well as ahead of it", () => {
    // Half past eight in the evening in New York is already tomorrow in UTC.
    const evening = new Date("2026-08-30T20:30:00-04:00");
    expect(businessToday("America/New_York", evening)).toBe("2026-08-30");
    expect(businessToday("UTC", evening)).toBe("2026-08-31");
  });

  it("agrees with UTC where the shop keeps UTC", () => {
    expect(businessToday("UTC", lateNightInIndia)).toBe(
      lateNightInIndia.toISOString().slice(0, 10),
    );
  });

  it("returns a day the rest of the product can parse", () => {
    // Every schema takes YYYY-MM-DD and every service turns it into midnight
    // UTC. A default the form cannot round-trip is worse than no default.
    const day = businessToday("Asia/Kolkata", lateNightInIndia);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(toUtcDay(day).toISOString().slice(0, 10)).toBe(day);
  });

  it("falls back to UTC rather than throwing on a zone it does not know", () => {
    // `Intl.DateTimeFormat` throws a RangeError on an unknown zone, and this is
    // on the path of a shop simply opening the sales page.
    expect(businessToday("Mars/Olympus", lateNightInIndia)).toBe("2026-08-29");
  });

  it("answers for every zone the settings screen offers", () => {
    for (const zone of BUSINESS_TIMEZONES) {
      expect(businessToday(zone, lateNightInIndia)).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    }
  });
});

describe("the stored time zone", () => {
  it("is constrained to zones the runtime can use", () => {
    const settings = {
      fiscalYearStartMonth: 4,
      currency: "INR",
      inventoryMethod: "WEIGHTED_AVERAGE" as const,
    };
    expect(
      companyAccountingSchema.safeParse({
        ...settings,
        timezone: "Asia/Kolkata",
      }).success,
    ).toBe(true);
    // Accepted while nothing read it; a RangeError waiting to happen once
    // something did.
    expect(
      companyAccountingSchema.safeParse({ ...settings, timezone: "Anywhere" })
        .success,
    ).toBe(false);
  });

  it("narrows a value stored before the field was constrained", () => {
    expect(asBusinessTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(asBusinessTimezone("Antarctica/Troll")).toBe("UTC");
    expect(asBusinessTimezone(null)).toBe("UTC");
    expect(asBusinessTimezone("")).toBe("UTC");
  });

  it("narrows to something businessToday agrees with", () => {
    // The settings form and the code that dates a document read the same
    // column. A form showing one zone while the books used another would be
    // the disagreement this setting exists to remove.
    const stored = "Not/AZone";
    expect(businessToday(asBusinessTimezone(stored), lateNightInIndia)).toBe(
      businessToday(stored, lateNightInIndia),
    );
  });
});

/**
 * Nothing works out what day it is from UTC.
 *
 * The eleven call sites this replaced were all spelled the same way, and the
 * next one will be too — it is the obvious thing to type. So the spelling is
 * the tripwire: `new Date().toISOString().slice(0, 10)` is the day in UTC, and
 * for a shop in Asia/Kolkata that is yesterday for the first five and a half
 * hours of every day.
 *
 * Formatting a date the books already hold is a different thing and stays
 * allowed — `sale.invoiceDate.toISOString().slice(0, 10)` reads back a value
 * stored at midnight UTC by construction. Only `new Date()` is caught.
 */
describe("no source works the day out from UTC", () => {
  it("has no call site left computing today in UTC", () => {
    const offenders = globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
      .filter((file) =>
        /new Date\(\)\s*\.toISOString\(\)\s*\.slice\(0,\s*10\)/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .sort();

    expect(offenders).toEqual([]);
  });
});
