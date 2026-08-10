import { describe, expect, it } from "vitest";
import { AccountNature } from "@prisma/client";
import {
  openingStockValue,
  signedOpening,
} from "@/server/master-data/opening-balance";
import { subtract, toStorageString } from "@/lib/money";

/**
 * The sign convention is the whole design of opening balances: every position
 * is expressed as a net *debit* to its control account, which is what lets one
 * posting routine handle receivables, payables and stock without branching on
 * the kind of record it came from.
 */
describe("signedOpening", () => {
  it("makes a receivable a positive debit", () => {
    expect(signedOpening(50_000, AccountNature.DEBIT).toString()).toBe("50000");
  });

  it("makes a payable a negative debit", () => {
    expect(signedOpening(30_000, AccountNature.CREDIT).toString()).toBe("-30000");
  });

  it("treats zero the same on either side", () => {
    expect(signedOpening(0, AccountNature.DEBIT).isZero()).toBe(true);
    expect(signedOpening(0, AccountNature.CREDIT).isZero()).toBe(true);
  });

  it("keeps paisa exactly", () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004; a balance
    // sheet that is out by a fraction of a paisa is still out.
    const total = signedOpening("0.1", AccountNature.DEBIT).plus(
      signedOpening("0.2", AccountNature.DEBIT),
    );
    expect(total.toString()).toBe("0.3");
  });
});

describe("openingStockValue", () => {
  it("values stock at quantity times cost", () => {
    expect(openingStockValue(40, 1450).toString()).toBe("58000");
  });

  it("handles a fractional quantity without drift", () => {
    expect(openingStockValue("12.5", "83.60").toString()).toBe("1045");
  });

  it("is zero when there is no stock", () => {
    expect(openingStockValue(0, 1450).isZero()).toBe(true);
  });
});

/**
 * The delta arithmetic that decides what a correction entry posts. Kept as a
 * plain expectation table because getting a sign wrong here would silently
 * double a customer's opening balance rather than correct it.
 */
describe("correction deltas", () => {
  const cases: Array<{
    label: string;
    from: [number, AccountNature];
    to: [number, AccountNature];
    expected: string;
  }> = [
    {
      label: "receivable raised",
      from: [50_000, AccountNature.DEBIT],
      to: [65_000, AccountNature.DEBIT],
      expected: "15000",
    },
    {
      label: "receivable lowered",
      from: [50_000, AccountNature.DEBIT],
      to: [20_000, AccountNature.DEBIT],
      expected: "-30000",
    },
    {
      label: "receivable flipped to an advance held",
      from: [50_000, AccountNature.DEBIT],
      to: [10_000, AccountNature.CREDIT],
      expected: "-60000",
    },
    {
      label: "payable raised",
      from: [30_000, AccountNature.CREDIT],
      to: [45_000, AccountNature.CREDIT],
      expected: "-15000",
    },
    {
      label: "payable cleared entirely",
      from: [30_000, AccountNature.CREDIT],
      to: [0, AccountNature.CREDIT],
      expected: "30000",
    },
    {
      label: "unchanged",
      from: [30_000, AccountNature.CREDIT],
      to: [30_000, AccountNature.CREDIT],
      expected: "0",
    },
  ];

  it.each(cases)("$label", ({ from, to, expected }) => {
    const delta = subtract(
      signedOpening(to[0], to[1]),
      signedOpening(from[0], from[1]),
    );
    expect(toStorageString(delta)).toBe(
      toStorageString(expected),
    );
  });

  it("nets back to zero when a change is reversed", () => {
    const original = signedOpening(50_000, AccountNature.DEBIT);
    const changed = signedOpening(10_000, AccountNature.CREDIT);
    const first = subtract(changed, original);
    const second = subtract(original, changed);
    expect(first.plus(second).isZero()).toBe(true);
  });
});
