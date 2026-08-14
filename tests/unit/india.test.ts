import { describe, expect, it } from "vitest";
import {
  GSTIN_PATTERN,
  INDIAN_MOBILE_PATTERN,
  INDIAN_STATES,
  PAN_PATTERN,
  PINCODE_PATTERN,
  findStateByCode,
  findStateByName,
  fiscalYearLabel,
  fiscalYearRange,
  gstinStateCode,
  panFromGstin,
} from "@/lib/constants/india";

describe("state reference data", () => {
  it("has unique state codes", () => {
    const codes = INDIAN_STATES.map((state) => state.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("uses two-digit codes throughout", () => {
    for (const state of INDIAN_STATES) {
      expect(state.code).toMatch(/^\d{2}$/);
    }
  });

  it("looks a state up by code and by name", () => {
    expect(findStateByCode("29")?.name).toBe("Karnataka");
    expect(findStateByCode("27")?.name).toBe("Maharashtra");
    expect(findStateByName("karnataka")?.code).toBe("29");
    expect(findStateByCode("99")).toBeUndefined();
  });
});

describe("GSTIN validation", () => {
  it("accepts well-formed GSTINs", () => {
    for (const gstin of [
      "29AABCA1234C1Z5",
      "27AAFCS5678D1Z9",
      "07AAAPR1234K1ZP",
    ]) {
      expect(GSTIN_PATTERN.test(gstin), gstin).toBe(true);
    }
  });

  it("rejects malformed GSTINs", () => {
    const invalid = [
      "29AABCA1234C1Z", // too short
      "29AABCA1234C1Z55", // too long
      "29aabca1234c1z5", // lowercase
      "29AABCA1234C1A5", // 14th character must be Z
      "", // empty
      "ABCDE1234F", // that is a PAN
    ];
    for (const gstin of invalid) {
      expect(GSTIN_PATTERN.test(gstin), gstin).toBe(false);
    }
  });

  it("extracts the state code, which decides CGST+SGST versus IGST", () => {
    expect(gstinStateCode("29AABCA1234C1Z5")).toBe("29");
    expect(gstinStateCode("not-a-gstin")).toBeNull();
  });

  it("extracts the embedded PAN so the two fields can be cross-checked", () => {
    expect(panFromGstin("29AABCA1234C1Z5")).toBe("AABCA1234C");
    expect(PAN_PATTERN.test(panFromGstin("29AABCA1234C1Z5") ?? "")).toBe(true);
    expect(panFromGstin("garbage")).toBeNull();
  });
});

describe("PAN, PIN code and mobile validation", () => {
  it("accepts valid PANs and rejects invalid ones", () => {
    expect(PAN_PATTERN.test("ABCDE1234F")).toBe(true);
    expect(PAN_PATTERN.test("ABCD1234F")).toBe(false);
    expect(PAN_PATTERN.test("abcde1234f")).toBe(false);
    expect(PAN_PATTERN.test("ABCDE12345")).toBe(false);
  });

  it("accepts valid PIN codes", () => {
    expect(PINCODE_PATTERN.test("560053")).toBe(true);
    expect(PINCODE_PATTERN.test("110001")).toBe(true);
    // Indian PIN codes never start with 0.
    expect(PINCODE_PATTERN.test("060053")).toBe(false);
    expect(PINCODE_PATTERN.test("56005")).toBe(false);
  });

  it("accepts Indian mobile numbers in the forms people type them", () => {
    for (const mobile of [
      "9845012345",
      "+919845012345",
      "91 9845012345",
      "+91-9845012345",
    ]) {
      expect(INDIAN_MOBILE_PATTERN.test(mobile), mobile).toBe(true);
    }
  });

  it("rejects numbers that are not valid Indian mobiles", () => {
    for (const mobile of [
      "1234567890",
      "5845012345",
      "98450123",
      "98450123456",
    ]) {
      expect(INDIAN_MOBILE_PATTERN.test(mobile), mobile).toBe(false);
    }
  });
});

describe("fiscal year", () => {
  it("labels an April-start year correctly", () => {
    expect(fiscalYearLabel(new Date("2026-08-09T00:00:00Z"))).toBe("2026-27");
    expect(fiscalYearLabel(new Date("2026-04-01T00:00:00Z"))).toBe("2026-27");
  });

  it("puts January to March in the preceding fiscal year", () => {
    expect(fiscalYearLabel(new Date("2026-03-31T00:00:00Z"))).toBe("2025-26");
    expect(fiscalYearLabel(new Date("2026-01-15T00:00:00Z"))).toBe("2025-26");
  });

  it("handles the century roll-over in the label", () => {
    expect(fiscalYearLabel(new Date("2099-06-01T00:00:00Z"))).toBe("2099-00");
  });

  it("supports a non-April fiscal start", () => {
    // A January-start year is simply the calendar year.
    expect(fiscalYearLabel(new Date("2026-08-09T00:00:00Z"), 1)).toBe(
      "2026-27",
    );
    expect(fiscalYearLabel(new Date("2026-08-09T00:00:00Z"), 10)).toBe(
      "2025-26",
    );
  });

  it("computes the inclusive date range", () => {
    const range = fiscalYearRange(new Date("2026-08-09T00:00:00Z"));
    expect(range.start.toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(range.end.toISOString().slice(0, 10)).toBe("2027-03-31");
    expect(range.label).toBe("2026-27");
  });

  it("returns a range that covers a leap-year February", () => {
    const range = fiscalYearRange(new Date("2027-06-01T00:00:00Z"));
    expect(range.start.toISOString().slice(0, 10)).toBe("2027-04-01");
    expect(range.end.toISOString().slice(0, 10)).toBe("2028-03-31");
  });

  it("produces a range whose start precedes its end for every start month", () => {
    for (let month = 1; month <= 12; month += 1) {
      const range = fiscalYearRange(new Date("2026-08-09T00:00:00Z"), month);
      expect(range.start.getTime()).toBeLessThan(range.end.getTime());
    }
  });
});
