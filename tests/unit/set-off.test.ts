import { describe, expect, it } from "vitest";
import { applySetOff, heads, totalHeads } from "@/lib/tax/set-off";

/**
 * The set-off order is prescribed, not a preference. Getting it wrong produces
 * a payable that is arithmetically defensible and legally wrong, and nothing
 * downstream would notice — so the whole table is exercised here, including the
 * two crossings that must never happen.
 */

const at = (
  result: ReturnType<typeof applySetOff>,
  key: keyof ReturnType<typeof heads>,
) => result.payable[key].toFixed(2);

describe("the order credit is used in", () => {
  it("uses IGST credit against IGST first", () => {
    const result = applySetOff({ igst: 1000 }, { igst: 1000 });
    expect(result.totalPayable.toFixed(2)).toBe("0.00");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ from: "igst", against: "igst" });
  });

  it("spills leftover IGST credit onto CGST, then SGST", () => {
    // ₹3,000 of IGST credit, no IGST liability: ₹1,000 clears CGST and the
    // rest goes to SGST, in that order.
    const result = applySetOff({ cgst: 1000, sgst: 1000 }, { igst: 3000 });

    expect(result.steps.map((step) => `${step.from}->${step.against}`)).toEqual(
      ["igst->cgst", "igst->sgst"],
    );
    expect(result.totalPayable.toFixed(2)).toBe("0.00");
    expect(result.carriedForward.igst.toFixed(2)).toBe("1000.00");
  });

  it("exhausts IGST credit before touching CGST or SGST credit", () => {
    // The rule that catches people out: IGST must be used up first, even when
    // matching heads are available.
    const result = applySetOff(
      { igst: 500, cgst: 500, sgst: 500 },
      { igst: 1000, cgst: 500, sgst: 500 },
    );

    // IGST credit clears the IGST liability and then spills onto CGST, which
    // is what "exhaust it first" means in practice.
    expect(result.steps.map((step) => `${step.from}->${step.against}`)).toEqual(
      ["igst->igst", "igst->cgst", "sgst->sgst"],
    );
    expect(result.carriedForward.igst.toFixed(2)).toBe("0.00");
    expect(result.totalPayable.toFixed(2)).toBe("0.00");
    // So the CGST credit is never needed and carries forward, while the SGST
    // credit does clear its own head — nothing else could have.
    expect(result.carriedForward.cgst.toFixed(2)).toBe("500.00");
    expect(result.carriedForward.sgst.toFixed(2)).toBe("0.00");
  });

  it("sends CGST credit to CGST, then to IGST", () => {
    const result = applySetOff({ cgst: 300, igst: 400 }, { cgst: 1000 });
    expect(result.steps.map((step) => `${step.from}->${step.against}`)).toEqual(
      ["cgst->cgst", "cgst->igst"],
    );
    expect(result.totalPayable.toFixed(2)).toBe("0.00");
    expect(result.carriedForward.cgst.toFixed(2)).toBe("300.00");
  });

  it("sends SGST credit to SGST, then to IGST", () => {
    const result = applySetOff({ sgst: 300, igst: 400 }, { sgst: 1000 });
    expect(result.steps.map((step) => `${step.from}->${step.against}`)).toEqual(
      ["sgst->sgst", "sgst->igst"],
    );
    expect(result.totalPayable.toFixed(2)).toBe("0.00");
  });
});

describe("what may never be set against what", () => {
  it("never sets CGST credit against SGST", () => {
    // The two belong to different governments; the set-off would move money
    // between them.
    const result = applySetOff({ sgst: 1000 }, { cgst: 1000 });

    expect(result.steps).toEqual([]);
    expect(at(result, "sgst")).toBe("1000.00");
    expect(result.carriedForward.cgst.toFixed(2)).toBe("1000.00");
  });

  it("never sets SGST credit against CGST", () => {
    const result = applySetOff({ cgst: 1000 }, { sgst: 1000 });

    expect(result.steps).toEqual([]);
    expect(at(result, "cgst")).toBe("1000.00");
    expect(result.carriedForward.sgst.toFixed(2)).toBe("1000.00");
  });

  it("ring-fences cess to cess", () => {
    const result = applySetOff({ igst: 500, cess: 200 }, { cess: 1000 });

    expect(result.steps.map((step) => `${step.from}->${step.against}`)).toEqual(
      ["cess->cess"],
    );
    expect(at(result, "igst")).toBe("500.00");
    expect(result.carriedForward.cess.toFixed(2)).toBe("800.00");
  });

  it("never uses IGST credit against cess", () => {
    const result = applySetOff({ cess: 500 }, { igst: 5000 });
    expect(result.steps).toEqual([]);
    expect(at(result, "cess")).toBe("500.00");
  });
});

describe("what is left over", () => {
  it("carries unused credit forward rather than refunding it", () => {
    const result = applySetOff(
      { cgst: 100, sgst: 100 },
      { cgst: 500, sgst: 500 },
    );

    expect(result.totalPayable.toFixed(2)).toBe("0.00");
    expect(result.totalCarriedForward.toFixed(2)).toBe("800.00");
  });

  it("leaves the liability standing when there is no credit", () => {
    const result = applySetOff({ cgst: 900, sgst: 900 }, {});

    expect(result.totalPayable.toFixed(2)).toBe("1800.00");
    expect(result.steps).toEqual([]);
    expect(result.totalCarriedForward.toFixed(2)).toBe("0.00");
  });

  it("handles a period with nothing in it", () => {
    const result = applySetOff({}, {});
    expect(result.totalPayable.toFixed(2)).toBe("0.00");
    expect(result.totalCarriedForward.toFixed(2)).toBe("0.00");
    expect(result.steps).toEqual([]);
  });

  it("applies only what is owed when credit exceeds it", () => {
    const result = applySetOff({ cgst: 90 }, { cgst: 100 });
    expect(result.steps[0]?.amount.toFixed(2)).toBe("90.00");
    expect(result.carriedForward.cgst.toFixed(2)).toBe("10.00");
  });
});

describe("the arithmetic holds", () => {
  it("never creates or destroys value", () => {
    // Credit used, credit carried forward and tax still payable must always
    // account for exactly what went in.
    const cases = [
      {
        liability: { igst: 1000, cgst: 500, sgst: 500 },
        credit: { igst: 1800 },
      },
      {
        liability: { cgst: 250.55, sgst: 250.55 },
        credit: { igst: 300, cgst: 100 },
      },
      { liability: { igst: 0.01 }, credit: { sgst: 0.02 } },
      { liability: { cess: 75 }, credit: { cess: 25 } },
    ];

    for (const { liability, credit } of cases) {
      const result = applySetOff(liability, credit);
      const used = result.steps.reduce(
        (total, step) => total.plus(step.amount),
        result.payable.igst.minus(result.payable.igst),
      );

      // Liability = what was set off + what is still payable.
      expect(used.plus(result.totalPayable).toFixed(2)).toBe(
        totalHeads(heads(liability)).toFixed(2),
      );

      // Credit = what was set off + what is carried forward.
      expect(used.plus(result.totalCarriedForward).toFixed(2)).toBe(
        totalHeads(heads(credit)).toFixed(2),
      );
    }
  });

  it("keeps paise exactly", () => {
    const result = applySetOff({ cgst: 100.57 }, { cgst: 100.56 });
    expect(at(result, "cgst")).toBe("0.01");
    expect(result.totalCarriedForward.toFixed(2)).toBe("0.00");
  });
});
