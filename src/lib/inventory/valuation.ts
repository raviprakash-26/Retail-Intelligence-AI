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
  /** What the pool is worth, which is the figure the books hold. */
  onHandValue: MoneyInput;
  quantity: MoneyInput;
}): ConsumptionResult {
  const requested = money(params.quantity);
  const available = money(params.onHandQuantity);

  if (compare(requested, available) > 0) {
    throw new InsufficientStockError(available, requested);
  }

  if (isZero(requested)) {
    return { cost: money(0), unitCost: money(0), remaining: [] };
  }

  // The share of the pool's value these units carry, rather than the quantity
  // times a rounded average.
  //
  // The two agree whenever the average divides exactly and part company when it
  // does not, and the case where that matters is the whole pool leaving. An
  // average is four decimal places wide, so three units holding ₹89.99 average
  // ₹29.9967 and cost ₹89.9901 to sell — a hundredth of a paisa more than the
  // shelf ever held. The quantity reaches nil and the value does not, and a
  // shelf with nothing on it is left worth a fraction of a paisa, in the
  // Inventory account, on the balance sheet, for good.
  //
  // Taking the share rather than the rate needs no special case for the whole
  // pool: value × q ÷ q comes back to the value it started from, where value ÷ q
  // × q does not.
  const held = money(params.onHandValue);
  const cost = divide(multiply(held, requested), available);

  return { cost, unitCost: divide(cost, requested), remaining: [] };
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

    const taken =
      compare(layer.quantity, outstanding) <= 0 ? layer.quantity : outstanding;

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
    onHandValue: MoneyInput;
    layers: readonly CostLayer[];
    quantity: MoneyInput;
  },
): ConsumptionResult {
  return method === "FIFO"
    ? consumeFifo({ layers: params.layers, quantity: params.quantity })
    : consumeWeightedAverage({
        onHandQuantity: params.onHandQuantity,
        onHandValue: params.onHandValue,
        quantity: params.quantity,
      });
}

/**
 * The new weighted average after stock comes in.
 *
 * Kept here rather than in the purchase module because a sale reversal puts
 * stock back and has to blend it the same way.
 *
 * Both sides come in as values rather than as a quantity and a rate. What is on
 * hand is worth what the books say it is worth, and re-deriving that as quantity
 * times the stored average blends a figure the balance sheet does not hold — the
 * average is four decimal places wide, and multiplying it back out does not
 * always land on the value it came from.
 */
export function blendAverageCost(params: {
  onHandQuantity: MoneyInput;
  onHandValue: MoneyInput;
  /** Stands when there is nothing to average. */
  averageCost: MoneyInput;
  inwardQuantity: MoneyInput;
  inwardValue: MoneyInput;
}): Decimal {
  const totalQuantity = add(params.onHandQuantity, params.inwardQuantity);

  // Nothing on hand and nothing coming in leaves the previous cost standing:
  // zero would misreport the next receipt's margin as pure profit.
  if (isZero(totalQuantity)) return money(params.averageCost);

  return divide(add(params.onHandValue, params.inwardValue), totalQuantity);
}

/** Quantity available across the layers a FIFO consumption would draw on. */
export function layersQuantity(layers: readonly CostLayer[]): Decimal {
  return add(...layers.map((layer) => layer.quantity));
}
