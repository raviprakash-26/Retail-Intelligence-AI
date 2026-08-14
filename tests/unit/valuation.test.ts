import { describe, expect, it } from "vitest";
import {
  InsufficientStockError,
  blendAverageCost,
  consume,
  consumeFifo,
  consumeWeightedAverage,
  layersQuantity,
  type CostLayer,
} from "@/lib/inventory/valuation";
import { money } from "@/lib/money";

function layer(
  sequence: number,
  quantity: string,
  unitCost: string,
): CostLayer {
  return { sequence, quantity: money(quantity), unitCost: money(unitCost) };
}

describe("weighted average", () => {
  it("costs everything at the pooled rate", () => {
    const result = consumeWeightedAverage({
      onHandQuantity: 100,
      averageCost: "42.50",
      quantity: 30,
    });

    expect(result.cost.toString()).toBe("1275");
    expect(result.unitCost.toString()).toBe("42.5");
  });

  it("refuses to sell stock that is not there", () => {
    expect(() =>
      consumeWeightedAverage({
        onHandQuantity: 5,
        averageCost: 10,
        quantity: 6,
      }),
    ).toThrow(InsufficientStockError);
  });

  it("allows selling the last of it exactly", () => {
    const result = consumeWeightedAverage({
      onHandQuantity: 5,
      averageCost: 10,
      quantity: 5,
    });
    expect(result.cost.toString()).toBe("50");
  });

  it("reports what was available so the message can name figures", () => {
    try {
      consumeWeightedAverage({
        onHandQuantity: 3,
        averageCost: 10,
        quantity: 8,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientStockError);
      const shortage = error as InsufficientStockError;
      expect(shortage.available.toString()).toBe("3");
      expect(shortage.requested.toString()).toBe("8");
    }
  });
});

describe("FIFO", () => {
  it("takes the oldest stock first", () => {
    const result = consumeFifo({
      layers: [layer(0, "10", "40"), layer(1, "10", "50")],
      quantity: 6,
    });

    expect(result.cost.toString()).toBe("240");
    expect(result.unitCost.toString()).toBe("40");
    expect(layersQuantity(result.remaining).toString()).toBe("14");
  });

  it("blends across layers when a sale spans two purchases", () => {
    // 10 at ₹40 then 5 of the next 10 at ₹50 → ₹650 for 15, ₹43.3333 each.
    const result = consumeFifo({
      layers: [layer(0, "10", "40"), layer(1, "10", "50")],
      quantity: 15,
    });

    expect(result.cost.toString()).toBe("650");
    expect(result.unitCost.toFixed(4)).toBe("43.3333");
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0]?.quantity.toString()).toBe("5");
  });

  it("empties the layers exactly when everything is sold", () => {
    const result = consumeFifo({
      layers: [layer(0, "10", "40"), layer(1, "5", "50")],
      quantity: 15,
    });

    expect(result.cost.toString()).toBe("650");
    expect(result.remaining).toHaveLength(0);
  });

  it("respects the sequence even when the layers arrive out of order", () => {
    const result = consumeFifo({
      layers: [
        layer(2, "10", "60"),
        layer(0, "10", "40"),
        layer(1, "10", "50"),
      ],
      quantity: 10,
    });
    expect(result.unitCost.toString()).toBe("40");
  });

  it("refuses to consume more than every layer holds", () => {
    expect(() =>
      consumeFifo({ layers: [layer(0, "4", "10")], quantity: 5 }),
    ).toThrow(InsufficientStockError);
  });

  it("refuses to consume from nothing at all", () => {
    expect(() => consumeFifo({ layers: [], quantity: 1 })).toThrow(
      InsufficientStockError,
    );
  });
});

describe("consume", () => {
  it("routes to the method the company keeps", () => {
    const params = {
      onHandQuantity: 20,
      averageCost: "45",
      layers: [layer(0, "10", "40"), layer(1, "10", "50")],
      quantity: 10,
    };

    // The same stock, valued two defensible ways: FIFO says these ten cost
    // ₹400 because that is what they cost; weighted average says ₹450 because
    // every unit in the pool is worth the same.
    expect(consume("FIFO", params).cost.toString()).toBe("400");
    expect(consume("WEIGHTED_AVERAGE", params).cost.toString()).toBe("450");
  });
});

describe("blendAverageCost", () => {
  it("blends a receipt into the pool", () => {
    // 10 at ₹40 plus 10 at ₹50 is 20 at ₹45.
    expect(
      blendAverageCost({
        onHandQuantity: 10,
        averageCost: 40,
        inwardQuantity: 10,
        inwardUnitCost: 50,
      }).toString(),
    ).toBe("45");
  });

  it("takes the receipt's cost when there was nothing on hand", () => {
    expect(
      blendAverageCost({
        onHandQuantity: 0,
        averageCost: 0,
        inwardQuantity: 40,
        inwardUnitCost: "1450",
      }).toString(),
    ).toBe("1450");
  });

  it("keeps the previous cost rather than collapsing to zero on an empty pool", () => {
    // Nothing on hand and nothing coming in: zeroing the cost here would make
    // the next sale look like pure profit.
    expect(
      blendAverageCost({
        onHandQuantity: 0,
        averageCost: "42.50",
        inwardQuantity: 0,
        inwardUnitCost: 0,
      }).toString(),
    ).toBe("42.5");
  });

  it("stays exact across repeated blends", () => {
    let quantity = money(0);
    let cost = money(0);

    for (let receipt = 0; receipt < 30; receipt += 1) {
      const inward = money(3);
      const price = money("10.33");
      cost = blendAverageCost({
        onHandQuantity: quantity,
        averageCost: cost,
        inwardQuantity: inward,
        inwardUnitCost: price,
      });
      quantity = quantity.plus(inward);
    }

    expect(cost.toFixed(4)).toBe("10.3300");
  });
});
