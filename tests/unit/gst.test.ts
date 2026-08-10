import { describe, expect, it } from "vitest";
import {
  chargesTax,
  computeLine,
  describeSupplyType,
  groupByRate,
  resolveSupplyType,
  splitIntoHalves,
  totalLines,
  totalsReconcile,
  type SupplyType,
} from "@/lib/tax/gst";

const KARNATAKA = "29";
const MAHARASHTRA = "27";

describe("resolveSupplyType", () => {
  it("treats a supply inside the seller's state as CGST + SGST", () => {
    expect(
      resolveSupplyType({
        registration: "REGULAR",
        sellerStateCode: KARNATAKA,
        placeOfSupplyStateCode: KARNATAKA,
      }),
    ).toBe("INTRA_STATE");
  });

  it("treats a supply into another state as IGST", () => {
    expect(
      resolveSupplyType({
        registration: "REGULAR",
        sellerStateCode: KARNATAKA,
        placeOfSupplyStateCode: MAHARASHTRA,
      }),
    ).toBe("INTER_STATE");
  });

  it("assumes the shop's own state for a walk-in with no place of supply", () => {
    // A customer carrying goods out of the shop is supplied where the shop is.
    expect(
      resolveSupplyType({
        registration: "REGULAR",
        sellerStateCode: KARNATAKA,
        placeOfSupplyStateCode: null,
      }),
    ).toBe("INTRA_STATE");
  });

  it("charges nothing when the seller is not registered", () => {
    expect(
      resolveSupplyType({
        registration: "UNREGISTERED",
        sellerStateCode: KARNATAKA,
        placeOfSupplyStateCode: MAHARASHTRA,
      }),
    ).toBe("NON_GST");
  });

  it("charges nothing for a composition dealer", () => {
    // A composition dealer pays tax on turnover out of their own margin and
    // must not collect it from the customer. Charging it would be a compliance
    // failure, not a rounding difference.
    expect(
      resolveSupplyType({
        registration: "COMPOSITION",
        sellerStateCode: KARNATAKA,
        placeOfSupplyStateCode: KARNATAKA,
      }),
    ).toBe("NON_GST");
  });

  it("zero-rates a supply from an SEZ", () => {
    expect(
      resolveSupplyType({
        registration: "SEZ",
        sellerStateCode: KARNATAKA,
        placeOfSupplyStateCode: KARNATAKA,
      }),
    ).toBe("EXPORT");
  });

  it.each<[SupplyType, boolean]>([
    ["INTRA_STATE", true],
    ["INTER_STATE", true],
    ["EXPORT", false],
    ["EXEMPT", false],
    ["NIL_RATED", false],
    ["NON_GST", false],
  ])("says whether %s charges tax", (supplyType, expected) => {
    expect(chargesTax(supplyType)).toBe(expected);
  });
});

describe("splitIntoHalves", () => {
  it("splits an even amount cleanly", () => {
    const [first, second] = splitIntoHalves(180);
    expect(first.toString()).toBe("90");
    expect(second.toString()).toBe("90");
  });

  it("gives the odd paisa to one side so the halves still sum to the whole", () => {
    // 222.21 halves to 111.105 twice; rounding both up invents a paisa.
    const [first, second] = splitIntoHalves("222.21");
    expect(first.plus(second).toString()).toBe("222.21");
    expect(first.toString()).toBe("111.11");
    expect(second.toString()).toBe("111.1");
  });

  it("never invents money, whatever the amount", () => {
    for (let paisa = 0; paisa < 200; paisa += 1) {
      const amount = (paisa / 100).toFixed(2);
      const [first, second] = splitIntoHalves(amount);
      expect(first.plus(second).toFixed(2)).toBe(amount);
    }
  });
});

describe("computeLine", () => {
  it("computes an 18% intra-state line", () => {
    const line = computeLine(
      { quantity: 10, rate: 100, taxPercent: 18 },
      "INTRA_STATE",
    );

    expect(line.taxableAmount.toString()).toBe("1000");
    expect(line.cgstAmount.toString()).toBe("90");
    expect(line.sgstAmount.toString()).toBe("90");
    expect(line.igstAmount.toString()).toBe("0");
    expect(line.lineTotal.toString()).toBe("1180");
  });

  it("charges the same total as IGST on an inter-state line", () => {
    const line = computeLine(
      { quantity: 10, rate: 100, taxPercent: 18 },
      "INTER_STATE",
    );

    expect(line.igstAmount.toString()).toBe("180");
    expect(line.cgstAmount.toString()).toBe("0");
    expect(line.lineTotal.toString()).toBe("1180");
  });

  it("applies a percentage discount before tax", () => {
    const line = computeLine(
      { quantity: 10, rate: 100, discountPercent: 10, taxPercent: 18 },
      "INTRA_STATE",
    );

    expect(line.grossAmount.toString()).toBe("1000");
    expect(line.discountAmount.toString()).toBe("100");
    expect(line.taxableAmount.toString()).toBe("900");
    expect(line.lineTotal.toString()).toBe("1062");
  });

  it("unwinds a tax-inclusive rate rather than adding tax on top", () => {
    // An MRP of ₹118 at 18% is ₹100 of value and ₹18 of tax — not ₹118 plus
    // ₹21.24, which is what applying the rate to the inclusive figure gives.
    const line = computeLine(
      { quantity: 1, rate: 118, taxPercent: 18, priceIncludesTax: true },
      "INTRA_STATE",
    );

    expect(line.taxableAmount.toString()).toBe("100");
    expect(line.cgstAmount.toString()).toBe("9");
    expect(line.sgstAmount.toString()).toBe("9");
    expect(line.lineTotal.toString()).toBe("118");
  });

  it("charges no tax when the supply is not taxable, whatever the product rate", () => {
    const line = computeLine(
      { quantity: 10, rate: 100, taxPercent: 18 },
      "NON_GST",
    );

    expect(line.taxPercent.toString()).toBe("0");
    expect(line.cgstAmount.toString()).toBe("0");
    expect(line.igstAmount.toString()).toBe("0");
    expect(line.lineTotal.toString()).toBe("1000");
  });

  it("handles a zero-rated product without inventing tax", () => {
    const line = computeLine(
      { quantity: 40, rate: 1620, taxPercent: 0 },
      "INTRA_STATE",
    );

    expect(line.taxableAmount.toString()).toBe("64800");
    expect(line.lineTotal.toString()).toBe("64800");
  });

  it("keeps a fractional quantity exact", () => {
    const line = computeLine(
      { quantity: "2.5", rate: "83.60", taxPercent: 5 },
      "INTRA_STATE",
    );

    expect(line.taxableAmount.toString()).toBe("209");
    expect(line.cgstAmount.plus(line.sgstAmount).toString()).toBe("10.45");
  });
});

describe("totalLines", () => {
  it("rounds the invoice to the rupee and records the difference", () => {
    const lines = [
      computeLine({ quantity: 3, rate: "33.33", taxPercent: 18 }, "INTRA_STATE"),
    ];
    const totals = totalLines(lines);

    // 99.99 + 18.00 tax = 117.99, billed at 118.
    expect(totals.taxableAmount.toString()).toBe("99.99");
    expect(totals.roundOff.toString()).toBe("0.01");
    expect(totals.totalAmount.toString()).toBe("118");
    expect(totalsReconcile(totals)).toBe(true);
  });

  it("rounds down as readily as up", () => {
    const lines = [
      computeLine({ quantity: 1, rate: "100.20", taxPercent: 0 }, "INTRA_STATE"),
    ];
    const totals = totalLines(lines);

    expect(totals.roundOff.toString()).toBe("-0.2");
    expect(totals.totalAmount.toString()).toBe("100");
    expect(totalsReconcile(totals)).toBe(true);
  });

  it("leaves the exact figure alone when rounding is off", () => {
    const lines = [
      computeLine({ quantity: 3, rate: "33.33", taxPercent: 18 }, "INTRA_STATE"),
    ];
    const totals = totalLines(lines, { roundToRupee: false });

    expect(totals.roundOff.toString()).toBe("0");
    expect(totals.totalAmount.toString()).toBe("117.99");
  });

  it("adds several lines at different rates", () => {
    const lines = [
      computeLine({ quantity: 2, rate: 500, taxPercent: 5 }, "INTRA_STATE"),
      computeLine({ quantity: 1, rate: 200, taxPercent: 18 }, "INTRA_STATE"),
      computeLine({ quantity: 4, rate: 25, taxPercent: 0 }, "INTRA_STATE"),
    ];
    const totals = totalLines(lines);

    expect(totals.taxableAmount.toString()).toBe("1300");
    // 5% of 1000 = 50; 18% of 200 = 36; nothing on the exempt line.
    expect(totals.cgstAmount.plus(totals.sgstAmount).toString()).toBe("86");
    expect(totals.totalAmount.toString()).toBe("1386");
    expect(totalsReconcile(totals)).toBe(true);
  });

  it("reconciles across a hundred randomised invoices", () => {
    // The property that matters: whatever the figures, the parts always add up
    // to the total that gets billed and posted.
    let seed = 20260810;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let invoice = 0; invoice < 100; invoice += 1) {
      const supplyType: SupplyType = next() > 0.5 ? "INTRA_STATE" : "INTER_STATE";
      const lines = Array.from({ length: 1 + Math.floor(next() * 6) }, () =>
        computeLine(
          {
            quantity: (next() * 20 + 0.01).toFixed(3),
            rate: (next() * 2000).toFixed(2),
            discountPercent: Math.floor(next() * 20),
            taxPercent: [0, 5, 12, 18, 28][Math.floor(next() * 5)] ?? 18,
          },
          supplyType,
        ),
      );

      const totals = totalLines(lines);
      expect(totalsReconcile(totals)).toBe(true);
      // A rupee round-off can never be more than half a rupee out.
      expect(totals.roundOff.abs().lessThanOrEqualTo("0.5")).toBe(true);
    }
  });
});

describe("groupByRate", () => {
  it("groups lines the way a GST return reports them", () => {
    const lines = [
      { ...computeLine({ quantity: 1, rate: 100, taxPercent: 18 }, "INTRA_STATE"), hsnCode: "1905" },
      { ...computeLine({ quantity: 2, rate: 100, taxPercent: 18 }, "INTRA_STATE"), hsnCode: "1905" },
      { ...computeLine({ quantity: 1, rate: 100, taxPercent: 5 }, "INTRA_STATE"), hsnCode: "1701" },
    ];

    const groups = groupByRate(lines);
    expect(groups).toHaveLength(2);

    const eighteen = groups.find((group) => group.taxPercent.toString() === "18");
    expect(eighteen?.taxableAmount.toString()).toBe("300");
    expect(eighteen?.totalTax.toString()).toBe("54");
    expect(eighteen?.hsnCode).toBe("1905");
  });

  it("keeps the same rate apart when the HSN differs", () => {
    const lines = [
      { ...computeLine({ quantity: 1, rate: 100, taxPercent: 18 }, "INTRA_STATE"), hsnCode: "1905" },
      { ...computeLine({ quantity: 1, rate: 100, taxPercent: 18 }, "INTRA_STATE"), hsnCode: "3401" },
    ];
    expect(groupByRate(lines)).toHaveLength(2);
  });
});

describe("describeSupplyType", () => {
  it("says nothing when tax is charged normally", () => {
    expect(describeSupplyType("INTRA_STATE", "REGULAR")).toBeNull();
  });

  it("explains a composition dealer's bill of supply", () => {
    const notice = describeSupplyType("NON_GST", "COMPOSITION");
    expect(notice).toContain("bill of supply");
    expect(notice).toContain("cannot collect GST");
  });

  it("explains an unregistered seller", () => {
    expect(describeSupplyType("NON_GST", "UNREGISTERED")).toContain(
      "not registered for GST",
    );
  });
});
