import { describe, expect, it } from "vitest";
import {
  BLOCKS,
  computeDepreciation,
  DEFAULT_BLOCK,
  HALF_RATE_DAYS,
  inferBlock,
  type AssetInput,
} from "@/lib/tax/depreciation";

/**
 * Depreciation under the Act, not in the books.
 *
 * The three things that go wrong in a hand-built schedule are all exercised
 * here: assets tracked one by one instead of pooled by rate, the half-rate rule
 * for a late purchase applied in the wrong year (or every year), and sale
 * proceeds taken off the asset instead of off the block.
 */

const FY = {
  from: new Date(Date.UTC(2025, 3, 1)),
  to: new Date(Date.UTC(2026, 2, 31)),
};

const asset = (
  overrides: Partial<AssetInput> & { id: string },
): AssetInput => ({
  name: "Shop equipment",
  category: "Equipment",
  purchaseDate: new Date(Date.UTC(2025, 3, 1)),
  purchaseCost: 100_000,
  ...overrides,
});

describe("choosing a block", () => {
  it("recognises the things a shop actually buys", () => {
    expect(inferBlock("Computers", "Billing laptop")).toBe("COMPUTER");
    expect(inferBlock("Furniture", "Display shelving")).toBe("FURNITURE");
    expect(inferBlock("Vehicles", "Delivery van")).toBe("MOTOR_VEHICLE");
    expect(inferBlock("Equipment", "Chest freezer")).toBe("PLANT_MACHINERY");
    expect(inferBlock("Premises", "Godown")).toBe("BUILDING_OTHER");
  });

  it("falls back to plant and machinery rather than guessing wildly", () => {
    expect(inferBlock("Sundry", "Thing")).toBe(DEFAULT_BLOCK);
    expect(inferBlock(null, undefined)).toBe(DEFAULT_BLOCK);
    expect(inferBlock("")).toBe(DEFAULT_BLOCK);
  });

  it("prefers the longer, more specific match", () => {
    // "delivery vehicle" must beat "table" appearing inside another word, and
    // a phrase must beat a single word that also matches.
    expect(inferBlock("Assets", "delivery vehicle")).toBe("MOTOR_VEHICLE");
  });

  it("never rates anything above the 40% ceiling", () => {
    // Rates were capped at 40% from assessment year 2018-19.
    for (const block of BLOCKS) {
      expect(block.ratePercent).toBeLessThanOrEqual(40);
      expect(block.ratePercent).toBeGreaterThan(0);
    }
  });
});

describe("a single year", () => {
  it("charges the full rate on an asset bought at the start of the year", () => {
    const schedule = computeDepreciation({
      assets: [asset({ id: "a", purchaseCost: 100_000 })],
      ...FY,
    });

    expect(schedule.blocks).toHaveLength(1);
    expect(schedule.blocks[0]?.ratePercent).toBe(15);
    expect(schedule.depreciation.toFixed(2)).toBe("15000.00");
    expect(schedule.closingWdv.toFixed(2)).toBe("85000.00");
  });

  it("charges half the rate on one bought too late in the year", () => {
    // 1 January leaves 90 days to 31 March, well under 180.
    const schedule = computeDepreciation({
      assets: [
        asset({ id: "a", purchaseDate: new Date(Date.UTC(2026, 0, 1)) }),
      ],
      ...FY,
    });

    expect(schedule.blocks[0]?.additionsHalfRate.toFixed(2)).toBe("100000.00");
    expect(schedule.depreciation.toFixed(2)).toBe("7500.00");
  });

  it("puts the boundary exactly at 180 days of holding", () => {
    const boundary = new Date(
      FY.to.getTime() - (HALF_RATE_DAYS - 1) * 86_400_000,
    );
    const dayLater = new Date(boundary.getTime() + 86_400_000);

    const onBoundary = computeDepreciation({
      assets: [asset({ id: "a", purchaseDate: boundary })],
      ...FY,
    });
    const justAfter = computeDepreciation({
      assets: [asset({ id: "a", purchaseDate: dayLater })],
      ...FY,
    });

    expect(onBoundary.depreciation.toFixed(2)).toBe("15000.00");
    expect(justAfter.depreciation.toFixed(2)).toBe("7500.00");
  });

  it("gives half the rate only in the year of purchase", () => {
    // Bought late in the previous year: half rate then, full rate now, and the
    // opening value reflects the smaller first charge.
    const schedule = computeDepreciation({
      assets: [
        asset({ id: "a", purchaseDate: new Date(Date.UTC(2025, 0, 1)) }),
      ],
      ...FY,
    });

    expect(schedule.openingWdv.toFixed(2)).toBe("92500.00");
    expect(schedule.blocks[0]?.additionsHalfRate.toFixed(2)).toBe("0.00");
    expect(schedule.depreciation.toFixed(2)).toBe("13875.00");
  });
});

describe("blocks, not assets", () => {
  it("pools everything that shares a rate", () => {
    const schedule = computeDepreciation({
      assets: [
        asset({ id: "a", category: "Equipment", purchaseCost: 100_000 }),
        asset({
          id: "b",
          category: "Vehicles",
          name: "Delivery van",
          purchaseCost: 200_000,
        }),
      ],
      ...FY,
    });

    // A freezer and a van are different things and the same 15% block.
    expect(schedule.blocks).toHaveLength(1);
    expect(schedule.blocks[0]?.assets).toHaveLength(2);
    expect(schedule.depreciation.toFixed(2)).toBe("45000.00");
  });

  it("keeps different rates apart", () => {
    const schedule = computeDepreciation({
      assets: [
        asset({ id: "a", category: "Equipment", purchaseCost: 100_000 }),
        asset({
          id: "b",
          category: "Computers",
          name: "Billing laptop",
          purchaseCost: 50_000,
        }),
      ],
      ...FY,
    });

    expect(schedule.blocks.map((block) => block.ratePercent)).toEqual([40, 15]);
    // 40% of 50,000 plus 15% of 1,00,000.
    expect(schedule.depreciation.toFixed(2)).toBe("35000.00");
  });

  it("honours a rate recorded against the asset over the guess", () => {
    const schedule = computeDepreciation({
      assets: [asset({ id: "a", category: "Computers", ratePercent: 15 })],
      ...FY,
    });

    expect(schedule.blocks[0]?.ratePercent).toBe(15);
    expect(schedule.blocks[0]?.assets[0]?.rateInferred).toBe(false);
    expect(schedule.depreciation.toFixed(2)).toBe("15000.00");
  });

  it("says out loud when it guessed", () => {
    const schedule = computeDepreciation({
      assets: [asset({ id: "a" })],
      ...FY,
    });
    expect(schedule.blocks[0]?.assets[0]?.rateInferred).toBe(true);
    expect(schedule.notes.join(" ")).toMatch(/placed in a block by what they/i);
  });
});

describe("disposals", () => {
  it("takes the proceeds off the block, not off the asset", () => {
    // Two assets bought a year ago, one sold. The block is
    // 1,70,000 opening less 40,000 proceeds = 1,30,000, depreciated at 15%.
    const lastYear = new Date(Date.UTC(2024, 3, 1));
    const schedule = computeDepreciation({
      assets: [
        asset({ id: "a", purchaseDate: lastYear, purchaseCost: 100_000 }),
        asset({
          id: "b",
          purchaseDate: lastYear,
          purchaseCost: 100_000,
          disposedAt: new Date(Date.UTC(2025, 8, 1)),
          disposalValue: 40_000,
        }),
      ],
      ...FY,
    });

    expect(schedule.openingWdv.toFixed(2)).toBe("170000.00");
    expect(schedule.disposals.toFixed(2)).toBe("40000.00");
    expect(schedule.depreciation.toFixed(2)).toBe("19500.00");
    expect(schedule.closingWdv.toFixed(2)).toBe("110500.00");
  });

  it("allows nothing where the proceeds exhaust the block", () => {
    const schedule = computeDepreciation({
      assets: [
        asset({
          id: "a",
          purchaseDate: new Date(Date.UTC(2024, 3, 1)),
          purchaseCost: 100_000,
          disposedAt: new Date(Date.UTC(2025, 8, 1)),
          disposalValue: 150_000,
        }),
      ],
      ...FY,
    });

    expect(schedule.depreciation.toFixed(2)).toBe("0.00");
    expect(schedule.closingWdv.toFixed(2)).toBe("0.00");
    expect(schedule.blocks[0]?.exhausted).toBe(true);
    expect(schedule.notes.join(" ")).toMatch(/capital gains/i);
  });

  it("allows nothing once the last asset in a block has gone", () => {
    // Sold for nothing at all: the block has no assets left, so no charge.
    const schedule = computeDepreciation({
      assets: [
        asset({
          id: "a",
          purchaseDate: new Date(Date.UTC(2024, 3, 1)),
          purchaseCost: 100_000,
          disposedAt: new Date(Date.UTC(2025, 8, 1)),
          disposalValue: 0,
        }),
      ],
      ...FY,
    });

    expect(schedule.depreciation.toFixed(2)).toBe("0.00");
    expect(schedule.blocks[0]?.exhausted).toBe(true);
  });
});

describe("the schedule as a whole", () => {
  it("balances: opening plus additions less disposals less depreciation", () => {
    const schedule = computeDepreciation({
      assets: [
        asset({
          id: "a",
          purchaseDate: new Date(Date.UTC(2023, 5, 10)),
          purchaseCost: 250_000,
        }),
        asset({
          id: "b",
          category: "Computers",
          name: "Server",
          purchaseDate: new Date(Date.UTC(2025, 11, 1)),
          purchaseCost: 60_000,
        }),
        asset({
          id: "c",
          category: "Furniture",
          name: "Shelving",
          purchaseDate: new Date(Date.UTC(2025, 4, 1)),
          purchaseCost: 80_000,
          disposedAt: new Date(Date.UTC(2026, 0, 15)),
          disposalValue: 10_000,
        }),
      ],
      ...FY,
    });

    const expected =
      Number(schedule.openingWdv) +
      Number(schedule.additions) -
      Number(schedule.disposals) -
      Number(schedule.depreciation);
    expect(Number(schedule.closingWdv)).toBeCloseTo(expected, 2);
  });

  it("is empty when there are no assets", () => {
    const schedule = computeDepreciation({ assets: [], ...FY });
    expect(schedule.blocks).toHaveLength(0);
    expect(schedule.depreciation.toFixed(2)).toBe("0.00");
    expect(schedule.notes).toHaveLength(0);
  });

  it("ignores an asset bought after the year it is reporting on", () => {
    const schedule = computeDepreciation({
      assets: [
        asset({ id: "a", purchaseDate: new Date(Date.UTC(2026, 5, 1)) }),
      ],
      ...FY,
    });
    expect(schedule.depreciation.toFixed(2)).toBe("0.00");
    expect(schedule.closingWdv.toFixed(2)).toBe("0.00");
  });

  it("rolls a block forward correctly over several years", () => {
    // 15% on ₹1,00,000 bought in April 2023: 15,000 then 12,750 then 10,837.50.
    const schedule = computeDepreciation({
      assets: [
        asset({ id: "a", purchaseDate: new Date(Date.UTC(2023, 3, 1)) }),
      ],
      ...FY,
    });
    expect(schedule.openingWdv.toFixed(2)).toBe("72250.00");
    expect(schedule.depreciation.toFixed(2)).toBe("10837.50");
  });
});
