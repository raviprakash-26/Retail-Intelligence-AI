import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  add,
  allocate,
  allocateByWeight,
  compare,
  divide,
  equals,
  money,
  multiply,
  netFromInclusive,
  percentOf,
  round2,
  roundOffDifference,
  subtract,
  sumBy,
  taxFromInclusive,
  toDecimal,
  toStorageString,
} from "@/lib/money";

describe("money — exactness", () => {
  it("does not accumulate floating-point error", () => {
    // The canonical float failure: 0.1 + 0.2 === 0.30000000000000004.
    expect(add(0.1, 0.2).toString()).toBe("0.3");
    expect(equals(add(0.1, 0.2), 0.3)).toBe(true);
  });

  it("stays exact across a long running total", () => {
    // 1000 additions of 0.01 lands on 9.999999999999831 in float arithmetic.
    const values = Array.from({ length: 1000 }, () => 0.01);
    expect(add(...values).toString()).toBe("10");
  });

  it("converts numbers via their string form, not their binary value", () => {
    expect(toDecimal(0.1).toString()).toBe("0.1");
    expect(toDecimal(1.005).toString()).toBe("1.005");
  });

  it("rejects non-finite numbers rather than storing NaN", () => {
    expect(() => toDecimal(Number.NaN)).toThrow(TypeError);
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it("treats null, undefined and empty string as zero", () => {
    expect(money(null).isZero()).toBe(true);
    expect(money(undefined).isZero()).toBe(true);
    expect(money("").isZero()).toBe(true);
  });

  it("parses amounts containing thousands separators", () => {
    expect(money("1,25,000.50").toString()).toBe("125000.5");
  });

  it("rejects text that is not a number", () => {
    expect(() => money("not an amount")).toThrow(TypeError);
  });
});

describe("money — rounding", () => {
  it("rounds half away from zero, as invoices do", () => {
    expect(round2("1.005").toFixed(2)).toBe("1.01");
    expect(round2("2.675").toFixed(2)).toBe("2.68");
    expect(round2("-1.005").toFixed(2)).toBe("-1.01");
  });

  it("stores at four decimal places", () => {
    expect(toStorageString("1.23456")).toBe("1.2346");
    expect(toStorageString(100)).toBe("100.0000");
  });

  it("computes the round-off posted to the round-off ledger", () => {
    expect(roundOffDifference("1234.60").toString()).toBe("0.4");
    expect(roundOffDifference("1234.40").toString()).toBe("-0.4");
    expect(roundOffDifference("1234.00").isZero()).toBe(true);
  });
});

describe("money — arithmetic", () => {
  it("adds, subtracts, multiplies and divides exactly", () => {
    expect(add(1, 2, 3).toString()).toBe("6");
    expect(subtract(10, 3, 2).toString()).toBe("5");
    expect(multiply(1.1, 3).toString()).toBe("3.3");
    expect(divide(10, 4).toString()).toBe("2.5");
  });

  it("refuses to divide by zero instead of returning Infinity", () => {
    expect(() => divide(100, 0)).toThrow(RangeError);
  });

  it("computes a percentage of an amount", () => {
    expect(percentOf(1000, 18).toString()).toBe("180");
    expect(percentOf("45000", 9).toString()).toBe("4050");
  });

  it("sums a projection over a collection", () => {
    const items = [
      { amount: "10.10" },
      { amount: "20.20" },
      { amount: "30.30" },
    ];
    expect(sumBy(items, (item) => item.amount).toString()).toBe("60.6");
  });

  it("orders amounts without float comparison", () => {
    expect(compare("0.30", add(0.1, 0.2))).toBe(0);
    expect(compare(10, 9.99)).toBe(1);
    expect(compare(9.99, 10)).toBe(-1);
  });
});

describe("money — tax extraction from inclusive amounts", () => {
  it("extracts the tax component correctly", () => {
    // ₹118 inclusive of 18% is ₹100 + ₹18 — not ₹118 × 18% = ₹21.24.
    expect(taxFromInclusive(118, 18).toString()).toBe("18");
    expect(netFromInclusive(118, 18).toString()).toBe("100");
  });

  it("handles the 5% slab", () => {
    expect(taxFromInclusive(105, 5).toString()).toBe("5");
    expect(netFromInclusive(105, 5).toString()).toBe("100");
  });

  it("returns zero tax for a nil-rated supply", () => {
    expect(taxFromInclusive(100, 0).isZero()).toBe(true);
    expect(netFromInclusive(100, 0).toString()).toBe("100");
  });

  it("round-trips: net plus tax equals the inclusive amount", () => {
    for (const rate of [0, 5, 12, 18, 28]) {
      for (const gross of ["1000", "1234.56", "99.99", "7"]) {
        const tax = taxFromInclusive(gross, rate);
        const net = netFromInclusive(gross, rate);
        expect(add(net, tax).toString()).toBe(money(gross).toString());
      }
    }
  });
});

describe("money — allocation", () => {
  it("splits an amount without losing a paisa", () => {
    const shares = allocate(100, 3);
    expect(shares).toHaveLength(3);
    expect(add(...shares).toString()).toBe("100");
  });

  it("distributes the remainder rather than dropping it", () => {
    // 100 / 3 = 33.3333 each; the leftover 0.0001 must land somewhere.
    const shares = allocate(100, 3).map((share) => share.toFixed(4));
    expect(shares).toEqual(["33.3334", "33.3333", "33.3333"]);
  });

  it("handles negative amounts", () => {
    const shares = allocate(-100, 3);
    expect(add(...shares).toString()).toBe("-100");
  });

  it("rejects an invalid part count", () => {
    expect(() => allocate(100, 0)).toThrow(RangeError);
    expect(() => allocate(100, 2.5)).toThrow(RangeError);
  });

  it("apportions by weight and preserves the total exactly", () => {
    // An invoice-level discount spread across three lines of different value.
    const shares = allocateByWeight(100, [1000, 500, 333]);
    expect(add(...shares).toString()).toBe("100");
    expect(compare(shares[0]!, shares[1]!)).toBe(1);
  });

  it("falls back to an even split when all weights are zero", () => {
    const shares = allocateByWeight(90, [0, 0, 0]);
    expect(shares).toHaveLength(3);
    expect(add(...shares).toString()).toBe("90");
  });
});

describe("money — Decimal interop", () => {
  it("accepts a Decimal without re-parsing it", () => {
    const value = new Decimal("123.4567");
    expect(money(value).toString()).toBe("123.4567");
  });
});
