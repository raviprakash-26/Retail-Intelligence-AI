import { describe, expect, it } from "vitest";
import {
  AGEING_BUCKETS,
  allocateOldestFirst,
  bucketFor,
  daysOverdue,
  summariseAgeing,
} from "@/lib/settlements/ageing";

/**
 * Ageing is the one report a retailer reads to decide who to phone, so the
 * arithmetic in it has to be boring and exact. The cases below are the ones
 * that would embarrass the product if they were wrong: an invoice due today,
 * an invoice due later, a boundary day, and money that runs out part way
 * through the oldest debt.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("daysOverdue", () => {
  it("counts whole days, not fractions", () => {
    // 4pm on the due date is not one day overdue.
    expect(
      daysOverdue(day("2026-04-10"), new Date("2026-04-10T16:30:00.000Z")),
    ).toBe(0);
    expect(
      daysOverdue(day("2026-04-10"), new Date("2026-04-11T00:05:00.000Z")),
    ).toBe(1);
  });

  it("is negative before the due date", () => {
    expect(daysOverdue(day("2026-04-30"), day("2026-04-10"))).toBe(-20);
  });

  it("crosses month and year ends", () => {
    expect(daysOverdue(day("2025-12-28"), day("2026-01-04"))).toBe(7);
    // 2028 is a leap year: February has 29 days.
    expect(daysOverdue(day("2028-02-01"), day("2028-03-01"))).toBe(29);
  });
});

describe("bucketFor", () => {
  it("treats anything not yet due as current", () => {
    expect(bucketFor(-40)).toBe("current");
    expect(bucketFor(0)).toBe("current");
  });

  it("puts each boundary day in the lower bucket", () => {
    expect(bucketFor(1)).toBe("d1_30");
    expect(bucketFor(30)).toBe("d1_30");
    expect(bucketFor(31)).toBe("d31_60");
    expect(bucketFor(60)).toBe("d31_60");
    expect(bucketFor(61)).toBe("d61_90");
    expect(bucketFor(90)).toBe("d61_90");
    expect(bucketFor(91)).toBe("d90_plus");
    expect(bucketFor(4000)).toBe("d90_plus");
  });

  it("agrees with the declared bucket bounds", () => {
    for (const bucket of AGEING_BUCKETS) {
      if (Number.isFinite(bucket.from)) {
        expect(bucketFor(bucket.from)).toBe(bucket.key);
      }
      if (bucket.to !== null) {
        expect(bucketFor(bucket.to)).toBe(bucket.key);
      }
    }
  });
});

describe("summariseAgeing", () => {
  const asOf = day("2026-04-30");

  it("totals into buckets and never counts current as overdue", () => {
    const summary = summariseAgeing(
      [
        { dueDate: day("2026-05-15"), outstanding: "1000.00" }, // not due
        { dueDate: day("2026-04-20"), outstanding: "500.00" }, // 10 days
        { dueDate: day("2026-03-10"), outstanding: "250.00" }, // 51 days
        { dueDate: day("2025-11-01"), outstanding: "125.50" }, // 180 days
      ],
      asOf,
    );

    expect(summary.total.toFixed(2)).toBe("1875.50");
    expect(summary.overdue.toFixed(2)).toBe("875.50");
    expect(summary.buckets.current.toFixed(2)).toBe("1000.00");
    expect(summary.buckets.d1_30.toFixed(2)).toBe("500.00");
    expect(summary.buckets.d31_60.toFixed(2)).toBe("250.00");
    expect(summary.buckets.d61_90.toFixed(2)).toBe("0.00");
    expect(summary.buckets.d90_plus.toFixed(2)).toBe("125.50");
    expect(summary.oldestOverdueDays).toBe(180);
  });

  it("buckets always sum to the total", () => {
    const summary = summariseAgeing(
      [
        { dueDate: day("2026-04-30"), outstanding: "0.05" },
        { dueDate: day("2026-04-29"), outstanding: "33.33" },
        { dueDate: day("2026-02-01"), outstanding: "66.67" },
        { dueDate: day("2024-01-01"), outstanding: "0.01" },
      ],
      asOf,
    );

    const summed = Object.values(summary.buckets).reduce(
      (total, value) => total.plus(value),
      summary.buckets.current.minus(summary.buckets.current),
    );
    expect(summed.toFixed(2)).toBe(summary.total.toFixed(2));
  });

  it("ignores settled and over-settled documents", () => {
    // A credit note can push paid past total. Letting a negative through would
    // net away somebody else's genuine debt.
    const summary = summariseAgeing(
      [
        { dueDate: day("2026-01-01"), outstanding: "0" },
        { dueDate: day("2026-01-01"), outstanding: "-500" },
        { dueDate: day("2026-01-01"), outstanding: "800" },
      ],
      asOf,
    );

    expect(summary.total.toFixed(2)).toBe("800.00");
    expect(summary.overdue.toFixed(2)).toBe("800.00");
  });

  it("reports nothing overdue when everything is within terms", () => {
    const summary = summariseAgeing(
      [{ dueDate: day("2026-06-01"), outstanding: "9000" }],
      asOf,
    );

    expect(summary.oldestOverdueDays).toBeNull();
    expect(summary.overdue.toFixed(2)).toBe("0.00");
  });

  it("returns zeroes for no documents", () => {
    const summary = summariseAgeing([], asOf);
    expect(summary.total.toFixed(2)).toBe("0.00");
    expect(summary.oldestOverdueDays).toBeNull();
  });
});

describe("allocateOldestFirst", () => {
  const documents = [
    { id: "new", outstanding: "5000", dueDate: day("2026-04-20") },
    { id: "old", outstanding: "1200", dueDate: day("2026-01-05") },
    { id: "middle", outstanding: "800", dueDate: day("2026-02-14") },
  ];

  it("clears the oldest debt first", () => {
    const { allocations, unallocated } = allocateOldestFirst(2000, documents);

    expect(allocations.map((entry) => entry.id)).toEqual(["old", "middle"]);
    expect(allocations[0]?.amount.toFixed(2)).toBe("1200.00");
    expect(allocations[1]?.amount.toFixed(2)).toBe("800.00");
    expect(unallocated.toFixed(2)).toBe("0.00");
  });

  it("part-settles the document the money runs out on", () => {
    const { allocations, unallocated } = allocateOldestFirst(1500, documents);

    expect(allocations).toHaveLength(2);
    expect(allocations[1]?.id).toBe("middle");
    expect(allocations[1]?.amount.toFixed(2)).toBe("300.00");
    expect(unallocated.toFixed(2)).toBe("0.00");
  });

  it("leaves the remainder on account when there is more money than debt", () => {
    const { allocations, unallocated } = allocateOldestFirst(10_000, documents);

    expect(allocations).toHaveLength(3);
    expect(unallocated.toFixed(2)).toBe("3000.00");
  });

  it("never allocates more than a document owes", () => {
    const { allocations } = allocateOldestFirst(999_999, documents);

    for (const allocation of allocations) {
      const document = documents.find((entry) => entry.id === allocation.id);
      expect(Number(allocation.amount)).toBeLessThanOrEqual(
        Number(document?.outstanding),
      );
    }
  });

  it("allocates nothing when there is nothing to allocate", () => {
    expect(allocateOldestFirst(0, documents).allocations).toEqual([]);
    expect(allocateOldestFirst(500, []).unallocated.toFixed(2)).toBe("500.00");
  });

  it("skips documents with nothing outstanding", () => {
    const { allocations } = allocateOldestFirst(1000, [
      { id: "settled", outstanding: "0", dueDate: day("2025-01-01") },
      { id: "open", outstanding: "400", dueDate: day("2026-01-01") },
    ]);

    expect(allocations.map((entry) => entry.id)).toEqual(["open"]);
  });

  it("keeps exact paise rather than drifting through floats", () => {
    const { allocations, unallocated } = allocateOldestFirst(100.1, [
      { id: "a", outstanding: "33.37", dueDate: day("2026-01-01") },
      { id: "b", outstanding: "33.37", dueDate: day("2026-01-02") },
      { id: "c", outstanding: "33.36", dueDate: day("2026-01-03") },
    ]);

    expect(allocations).toHaveLength(3);
    expect(unallocated.toFixed(2)).toBe("0.00");
  });
});
