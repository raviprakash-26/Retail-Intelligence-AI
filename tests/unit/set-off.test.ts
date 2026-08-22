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

/**
 * Where the leftover IGST credit goes.
 *
 * The sequence of heads is prescribed and the two crossings are forbidden, but
 * one thing is not fixed: rule 88A says IGST credit is used against IGST first
 * and the remainder "may be utilised towards the payment of central tax and
 * State tax or Union territory tax, as the case may be, **in any order and in
 * any proportion**".
 *
 * That choice belongs to the taxpayer, and it is worth money. CGST credit
 * cannot pay SGST and SGST credit cannot pay CGST, so IGST credit is the only
 * credit that can reach either. Spending it on a head that its own credit was
 * going to cover anyway strands the other head's shortfall, and the shop pays
 * that shortfall in cash while the credit it could not use is carried forward.
 *
 * This went unnoticed because the two cases above that fix an order both come
 * to nil payable whichever way the credit is split, so neither could show the
 * cost.
 */
describe("choosing where leftover IGST credit goes", () => {
  it("sends it where a head's own credit cannot reach", () => {
    // The ordinary retail position: stock bought interstate gives IGST credit,
    // stock bought locally gives CGST and SGST credit, and local sales are
    // owed in CGST and SGST.
    //
    // Spent CGST-first, ₹100 of IGST clears the whole CGST liability, the
    // ₹30 of CGST credit is left with nothing to pay and carries forward, and
    // the shop pays ₹70 of SGST in cash. Split across both shortfalls, it pays
    // ₹40 — which is the whole liability less the whole credit, and nothing is
    // stranded.
    const result = applySetOff(
      { cgst: 100, sgst: 100 },
      { igst: 100, cgst: 30, sgst: 30 },
    );

    expect(result.totalPayable.toFixed(2)).toBe("40.00");

    // Nothing is left over. Credit carried forward beside cash paid is the
    // signature of the wrong split, so its absence is the thing to assert.
    expect(result.totalCarriedForward.toFixed(2)).toBe("0.00");

    // Which head that ₹40 sits under is deliberately not asserted. The pool
    // cannot cover both shortfalls here, and every division of it comes to the
    // same cash — so pinning one would be repeating the mistake this fixes.
    expect(at(result, "igst")).toBe("0.00");
  });

  it("leaves alone a head its own credit already covers", () => {
    // All the IGST credit belongs on SGST: the CGST liability is already
    // covered twice over by CGST credit, so a rupee of IGST spent there is a
    // rupee that has to be found in cash on the other side.
    const result = applySetOff(
      { cgst: 100, sgst: 100 },
      { igst: 100, cgst: 200, sgst: 0 },
    );

    expect(result.totalPayable.toFixed(2)).toBe("0.00");
    expect(
      result.steps
        .filter((step) => step.from === "igst")
        .map((step) => `${step.against} ${step.amount.toFixed(2)}`),
    ).toEqual(["sgst 100.00"]);
    // The CGST credit that was never needed is what carries forward.
    expect(result.carriedForward.cgst.toFixed(2)).toBe("100.00");
  });

  it("never pays cash that another permissible split would have avoided", () => {
    // Stated as the property rather than as a figure. Every split of the
    // leftover IGST credit between the two heads is allowed by rule 88A, so
    // the one taken must not cost more than any of them.
    //
    // The alternative below is deliberately not a second implementation of the
    // set-off: with no IGST liability in play it is just the two shortfalls
    // left after the credit each head can use, which is all that has to be
    // beaten.
    const leastPayable = (
      liabilityC: number,
      liabilityS: number,
      creditC: number,
      creditS: number,
      pool: number,
    ) => {
      let best = Number.POSITIVE_INFINITY;
      for (let toCgst = 0; toCgst <= pool; toCgst += 1) {
        const usedC = Math.min(toCgst, liabilityC);
        const usedS = Math.min(pool - toCgst, liabilityS);
        best = Math.min(
          best,
          Math.max(0, liabilityC - usedC - creditC) +
            Math.max(0, liabilityS - usedS - creditS),
        );
      }
      return best;
    };

    const cases: Array<[number, number, number, number, number]> = [
      [100, 100, 30, 30, 100],
      [100, 100, 200, 0, 100],
      [900, 400, 0, 500, 600],
      [250, 250, 100, 0, 300],
      [500, 500, 500, 500, 400],
      [80, 20, 10, 90, 50],
      [1000, 1000, 0, 0, 2500],
      [0, 750, 400, 0, 300],
    ];

    for (const [lc, ls, cc, cs, pool] of cases) {
      const result = applySetOff(
        { cgst: lc, sgst: ls },
        { igst: pool, cgst: cc, sgst: cs },
      );
      expect(
        Number(result.totalPayable.toFixed(2)),
        `liability ${lc}/${ls}, own credit ${cc}/${cs}, IGST ${pool}`,
      ).toBe(leastPayable(lc, ls, cc, cs, pool));
    }
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
