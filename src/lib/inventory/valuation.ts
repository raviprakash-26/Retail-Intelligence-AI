import {
  type Decimal,
  add,
  compare,
  divide,
  isZero,
  money,
  multiply,
  subtract,
  type MoneyInput,
} from "@/lib/money";

/**
 * Stock valuation.
 *
 * Pure, so both methods can be tested against worked examples rather than
 * against whatever the database happened to contain. What comes out of here is
 * the cost of goods sold — the difference between a business that looks
 * profitable and one that is.
 */

export type InventoryMethod = "FIFO" | "WEIGHTED_AVERAGE";

/** One inward receipt that still has stock left against it. */
export type CostLayer = {
  /** Ordering key; oldest first for FIFO. */
  sequence: number;
  quantity: Decimal;
  unitCost: Decimal;
};

export type ConsumptionResult = {
  /** Total cost of the quantity taken out. */
  cost: Decimal;
  /** Effective cost per unit — cost ÷ quantity, for the invoice line. */
  unitCost: Decimal;
  /** Layers as they stand after the consumption, for FIFO. */
  remaining: CostLayer[];
};

export class InsufficientStockError extends Error {
  constructor(
    readonly available: Decimal,
    readonly requested: Decimal,
  ) {
    super(
      `Only ${available.toString()} in stock; ${requested.toString()} requested.`,
    );
    this.name = "InsufficientStockError";
  }
}

/**
 * Weighted average: every unit costs the same, whatever it was bought for.
 *
 * This is what most Indian retailers keep, and it is what the demo tenant uses.
 * A new receipt blends into the pool rather than forming its own layer.
 */
export function consumeWeightedAverage(params: {
  onHandQuantity: MoneyInput;
  averageCost: MoneyInput;
  quantity: MoneyInput;
}): ConsumptionResult {
  const requested = money(params.quantity);
  const available = money(params.onHandQuantity);

  if (compare(requested, available) > 0) {
    throw new InsufficientStockError(available, requested);
  }

  const unitCost = money(params.averageCost);
  return {
    cost: multiply(requested, unitCost),
    unitCost,
    remaining: [],
  };
}

/**
 * FIFO: the oldest stock leaves first, at what it actually cost.
 *
 * Layers are walked in order and drained. A sale that spans two purchases at
 * different prices produces a blended unit cost, which is exactly right — that
 * is what those goods cost.
 */
export function consumeFifo(params: {
  layers: readonly CostLayer[];
  quantity: MoneyInput;
}): ConsumptionResult {
  const requested = money(params.quantity);
  const available = add(...params.layers.map((layer) => layer.quantity));

  if (compare(requested, available) > 0) {
    throw new InsufficientStockError(available, requested);
  }

  const ordered = [...params.layers].sort((a, b) => a.sequence - b.sequence);
  const remaining: CostLayer[] = [];
  let outstanding = requested;
  let cost = money(0);

  for (const layer of ordered) {
    if (isZero(outstanding)) {
      remaining.push(layer);
      continue;
    }

    const taken = compare(layer.quantity, outstanding) <= 0
      ? layer.quantity
      : outstanding;

    cost = add(cost, multiply(taken, layer.unitCost));
    outstanding = subtract(outstanding, taken);

    const left = subtract(layer.quantity, taken);
    if (!isZero(left)) {
      remaining.push({ ...layer, quantity: left });
    }
  }

  return {
    cost,
    unitCost: isZero(requested) ? money(0) : divide(cost, requested),
    remaining,
  };
}

export function consume(
  method: InventoryMethod,
  params: {
    onHandQuantity: MoneyInput;
    averageCost: MoneyInput;
    layers: readonly CostLayer[];
    quantity: MoneyInput;
  },
): ConsumptionResult {
  return method === "FIFO"
    ? consumeFifo({ layers: params.layers, quantity: params.quantity })
    : consumeWeightedAverage({
        onHandQuantity: params.onHandQuantity,
        averageCost: params.averageCost,
        quantity: params.quantity,
      });
}

/**
 * The new weighted average after stock comes in.
 *
 * Kept here rather than in the purchase module because a sale reversal puts
 * stock back and has to blend it the same way.
 */
export function blendAverageCost(params: {
  onHandQuantity: MoneyInput;
  averageCost: MoneyInput;
  inwardQuantity: MoneyInput;
  inwardUnitCost: MoneyInput;
}): Decimal {
  const existingValue = multiply(params.onHandQuantity, params.averageCost);
  const inwardValue = multiply(params.inwardQuantity, params.inwardUnitCost);
  const totalQuantity = add(params.onHandQuantity, params.inwardQuantity);

  // Nothing on hand and nothing coming in leaves the previous cost standing:
  // zero would misreport the next receipt's margin as pure profit.
  if (isZero(totalQuantity)) return money(params.averageCost);

  return divide(add(existingValue, inwardValue), totalQuantity);
}

/** Quantity available across the layers a FIFO consumption would draw on. */
export function layersQuantity(layers: readonly CostLayer[]): Decimal {
  return add(...layers.map((layer) => layer.quantity));
}
