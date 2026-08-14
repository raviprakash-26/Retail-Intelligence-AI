import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatCurrencyCompact,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  initialsOf,
  maskIdentifier,
} from "@/lib/format";

/**
 * How every figure in the product is written.
 *
 * These are small functions and they were the least-tested module in the
 * codebase, which is an odd place to leave a gap: every rupee a shopkeeper
 * reads goes through `formatCurrency`, and an off-by-one in the rounding here
 * would be visible on every page while every accounting test stayed green.
 *
 * The Indian grouping — 1,85,000 rather than 185,000 — is the part most likely
 * to be broken by somebody changing a locale default without thinking about who
 * reads the screen.
 */

describe("money on the page", () => {
  it("groups in lakhs, the way the reader counts", () => {
    expect(formatCurrency(185_000)).toBe("₹1,85,000.00");
    expect(formatCurrency(10_000_000)).toBe("₹1,00,00,000.00");
  });

  it("keeps the paise, because a ledger does", () => {
    expect(formatCurrency(1234.5)).toBe("₹1,234.50");
    expect(formatCurrency("0.05")).toBe("₹0.05");
  });

  it("drops the paise only when asked and only when they are nil", () => {
    expect(formatCurrency(1200, { compactZeroDecimals: true })).toBe("₹1,200");
    expect(formatCurrency(1200.5, { compactZeroDecimals: true })).toBe(
      "₹1,200.50",
    );
  });

  it("rounds half away from zero, as the money helpers do", () => {
    // Presentation must not disagree with the arithmetic underneath it.
    expect(formatCurrency("1234.565")).toBe("₹1,234.57");
  });

  it("can leave the symbol off for a column that has it in the header", () => {
    expect(formatCurrency(1234.5, { withoutSymbol: true })).toBe("1,234.50");
  });

  it("writes a negative amount as a negative amount", () => {
    // Not brackets, not red text with the sign dropped: a minus.
    expect(formatCurrency(-500)).toContain("500.00");
    expect(formatCurrency(-500)).toMatch(/-|−/);
  });

  it("abbreviates in lakhs and crores where the paise are noise", () => {
    expect(formatCurrencyCompact(540_000)).toBe("₹5.4L");
    expect(formatCurrencyCompact(12_000_000)).toBe("₹1.2Cr");
    expect(formatCurrencyCompact(4_300)).toBe("₹4.3K");
    expect(formatCurrencyCompact(85)).toBe("₹85");
  });
});

describe("quantities and percentages", () => {
  it("keeps three decimals of a quantity, because stock is sold in fractions", () => {
    expect(formatNumber("12.345")).toBe("12.345");
    expect(formatNumber("12.3456")).toBe("12.346");
  });

  it("writes a percentage to one place by default", () => {
    expect(formatPercent(12.34)).toBe("12.3%");
    expect(formatPercent(12.34, { fractionDigits: 2 })).toBe("12.34%");
  });

  it("marks a rise with a plus only when asked", () => {
    expect(formatPercent(5, { withSign: true })).toBe("+5.0%");
    expect(formatPercent(-5, { withSign: true })).toBe("-5.0%");
    expect(formatPercent(0, { withSign: true })).toBe("0.0%");
  });
});

describe("dates", () => {
  it("writes them the way an Indian invoice does", () => {
    expect(formatDate("2026-08-09")).toBe("09 Aug 2026");
  });

  it("accepts a Date or a string, and says nothing about nonsense", () => {
    expect(formatDate(new Date("2026-08-09T00:00:00.000Z"))).toBe(
      "09 Aug 2026",
    );
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });

  it("shows a time when the time is the point", () => {
    expect(formatDateTime("2026-08-09T10:30:00.000Z")).toMatch(/09 Aug 2026/);
  });

  it("counts backwards in words for a feed", () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    expect(formatRelativeTime("2026-08-06T12:00:00.000Z", { now })).toBe(
      "3 days ago",
    );
    expect(formatRelativeTime("2026-08-10T12:00:00.000Z", { now })).toBe(
      "tomorrow",
    );
    expect(formatRelativeTime(null)).toBe("—");
  });
});

describe("identifiers and names", () => {
  it("masks all but the last four of an account number", () => {
    expect(maskIdentifier("123456789012")).toBe("••••••••9012");
    expect(maskIdentifier("1234")).toBe("••••");
    expect(maskIdentifier(null)).toBe("—");
  });

  it("never lets the mask hint at the length of a long number", () => {
    // Eight dots whatever comes before, so a twelve-digit account and a
    // twenty-digit one look the same.
    expect(maskIdentifier("1234567890123456789012").length).toBe(12);
  });

  it("takes initials from a name without inventing any", () => {
    expect(initialsOf("Ravi Prakash")).toBe("RP");
    expect(initialsOf("  ")).toBe("?");
    expect(initialsOf(null)).toBe("?");
  });
});
