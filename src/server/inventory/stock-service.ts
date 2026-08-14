import "server-only";
import { StockMovementType } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import {
  blendAverageCost,
  consume,
  layersQuantity,
  type CostLayer,
  type InventoryMethod,
} from "@/lib/inventory/valuation";
import {
  type Decimal,
  add,
  money,
  multiply,
  subtract,
  toStorageString,
  type MoneyInput,
} from "@/lib/money";

/**
 * Stock positions and the ledger behind them.
 *
 * `inventory_balances` is a cache of where a product stands; `inventory_movements`
 * is the append-only record of how it got there. Every quantity change writes a
 * movement, so a position can always be rebuilt from the ledger and checked
 * against the cached figure.
 *
 * The valuation arithmetic lives in `lib/inventory/valuation`, which knows
 * nothing about the database. This module is only responsible for reading the
 * position, handing it over, and writing the result back.
 */

/** Movement types that bring stock in. Everything else takes it out. */
const INWARD: ReadonlySet<StockMovementType> = new Set([
  StockMovementType.OPENING,
  StockMovementType.PURCHASE,
  StockMovementType.SALES_RETURN,
  StockMovementType.ADJUSTMENT_IN,
  StockMovementType.TRANSFER_IN,
]);

export type StockPosition = {
  quantity: Decimal;
  averageCost: Decimal;
  stockValue: Decimal;
  /** Remaining FIFO layers, oldest first. Empty under weighted average. */
  layers: CostLayer[];
};

/**
 * Rebuilds the FIFO layers still standing for a product.
 *
 * Derived from the movement ledger rather than stored, because the ledger is
 * the record that cannot drift. It replays every movement for the product, so
 * cost grows with a product's history — acceptable for a shop's lifetime of
 * movements, and the point at which it stops being acceptable is the point at
 * which layers get their own table, in the Inventory module.
 */
async function rebuildLayers(
  tx: DbClient,
  params: { companyId: string; productId: string; branchId: string | null },
): Promise<CostLayer[]> {
  const movements = await tx.inventoryMovement.findMany({
    where: {
      companyId: params.companyId,
      productId: params.productId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    select: {
      movementType: true,
      quantity: true,
      unitCost: true,
      movementDate: true,
      createdAt: true,
    },
    orderBy: [{ movementDate: "asc" }, { createdAt: "asc" }],
  });

  const layers: CostLayer[] = [];
  let sequence = 0;

  for (const movement of movements) {
    // Quantities are stored signed, but the movement type is what says which
    // direction it was: an adjustment out with a positive figure is still out.
    const magnitude = money(movement.quantity).abs();
    if (magnitude.isZero()) continue;

    if (INWARD.has(movement.movementType)) {
      layers.push({
        sequence: sequence++,
        quantity: magnitude,
        unitCost: money(movement.unitCost),
      });
      continue;
    }

    let outstanding = magnitude;
    while (outstanding.greaterThan(0) && layers.length > 0) {
      const oldest = layers[0];
      if (!oldest) break;

      if (oldest.quantity.lessThanOrEqualTo(outstanding)) {
        outstanding = subtract(outstanding, oldest.quantity);
        layers.shift();
      } else {
        oldest.quantity = subtract(oldest.quantity, outstanding);
        outstanding = money(0);
      }
    }
  }

  return layers;
}

export async function readPosition(
  tx: DbClient,
  params: {
    companyId: string;
    productId: string;
    branchId: string | null;
    method: InventoryMethod;
  },
): Promise<StockPosition> {
  const balance = await tx.inventoryBalance.findFirst({
    where: {
      companyId: params.companyId,
      productId: params.productId,
      branchId: params.branchId,
    },
    select: { quantity: true, averageCost: true, stockValue: true },
  });

  const layers =
    params.method === "FIFO"
      ? await rebuildLayers(tx, {
          companyId: params.companyId,
          productId: params.productId,
          branchId: params.branchId,
        })
      : [];

  return {
    quantity: money(balance?.quantity ?? 0),
    averageCost: money(balance?.averageCost ?? 0),
    stockValue: money(balance?.stockValue ?? 0),
    layers,
  };
}

async function writeBalance(
  tx: DbClient,
  params: {
    companyId: string;
    productId: string;
    branchId: string | null;
    quantity: Decimal;
    averageCost: Decimal;
    stockValue: Decimal;
    movementDate: Date;
  },
): Promise<void> {
  const existing = await tx.inventoryBalance.findFirst({
    where: {
      companyId: params.companyId,
      productId: params.productId,
      branchId: params.branchId,
    },
    select: { id: true },
  });

  const data = {
    quantity: toStorageString(params.quantity),
    averageCost: toStorageString(params.averageCost),
    stockValue: toStorageString(params.stockValue),
    lastMovementAt: params.movementDate,
  };

  if (existing) {
    await tx.inventoryBalance.update({ where: { id: existing.id }, data });
    return;
  }

  await tx.inventoryBalance.create({
    data: {
      companyId: params.companyId,
      productId: params.productId,
      branchId: params.branchId,
      ...data,
    },
  });
}

export type MovementResult = {
  /** Total value moved. */
  value: Decimal;
  /** Cost per unit that was applied. */
  unitCost: Decimal;
  quantityAfter: Decimal;
};

/**
 * Takes stock out and reports what it cost.
 *
 * Refuses to go negative. Stock the business does not have cannot have a cost,
 * so allowing it would post a fabricated cost of goods sold and leave a
 * negative asset on the balance sheet — the invoice would look fine and the
 * accounts would be wrong.
 */
export async function recordOutward(
  tx: DbClient,
  params: {
    companyId: string;
    productId: string;
    branchId: string | null;
    method: InventoryMethod;
    quantity: MoneyInput;
    movementType: StockMovementType;
    movementDate: Date;
    sourceType: string;
    sourceId: string;
    referenceNo?: string | null;
    notes?: string | null;
    createdById?: string | null;
  },
): Promise<MovementResult> {
  const position = await readPosition(tx, params);

  const consumption = consume(params.method, {
    onHandQuantity:
      params.method === "FIFO"
        ? layersQuantity(position.layers)
        : position.quantity,
    averageCost: position.averageCost,
    layers: position.layers,
    quantity: params.quantity,
  });

  const quantityAfter = subtract(position.quantity, params.quantity);
  const valueAfter = subtract(position.stockValue, consumption.cost);

  await writeBalance(tx, {
    companyId: params.companyId,
    productId: params.productId,
    branchId: params.branchId,
    quantity: quantityAfter,
    // Weighted average is unchanged by an outward movement; FIFO's headline
    // average follows the value left behind.
    averageCost:
      params.method === "FIFO" && quantityAfter.greaterThan(0)
        ? valueAfter.dividedBy(quantityAfter)
        : position.averageCost,
    stockValue: valueAfter,
    movementDate: params.movementDate,
  });

  await tx.inventoryMovement.create({
    data: {
      companyId: params.companyId,
      productId: params.productId,
      branchId: params.branchId,
      movementType: params.movementType,
      movementDate: params.movementDate,
      quantity: toStorageString(money(params.quantity).negated()),
      unitCost: toStorageString(consumption.unitCost),
      value: toStorageString(consumption.cost.negated()),
      balanceQuantity: toStorageString(quantityAfter),
      balanceValue: toStorageString(valueAfter),
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      referenceNo: params.referenceNo ?? null,
      notes: params.notes ?? null,
      createdById: params.createdById ?? null,
    },
  });

  return {
    value: consumption.cost,
    unitCost: consumption.unitCost,
    quantityAfter,
  };
}

/** Puts stock in at a known cost, blending the weighted average. */
export async function recordInward(
  tx: DbClient,
  params: {
    companyId: string;
    productId: string;
    branchId: string | null;
    method: InventoryMethod;
    quantity: MoneyInput;
    unitCost: MoneyInput;
    movementType: StockMovementType;
    movementDate: Date;
    sourceType: string;
    sourceId: string;
    referenceNo?: string | null;
    notes?: string | null;
    createdById?: string | null;
  },
): Promise<MovementResult> {
  const position = await readPosition(tx, params);

  const value = multiply(params.quantity, params.unitCost);
  const quantityAfter = add(position.quantity, params.quantity);
  const valueAfter = add(position.stockValue, value);

  const averageCost = blendAverageCost({
    onHandQuantity: position.quantity,
    averageCost: position.averageCost,
    inwardQuantity: params.quantity,
    inwardUnitCost: params.unitCost,
  });

  await writeBalance(tx, {
    companyId: params.companyId,
    productId: params.productId,
    branchId: params.branchId,
    quantity: quantityAfter,
    averageCost,
    stockValue: valueAfter,
    movementDate: params.movementDate,
  });

  await tx.inventoryMovement.create({
    data: {
      companyId: params.companyId,
      productId: params.productId,
      branchId: params.branchId,
      movementType: params.movementType,
      movementDate: params.movementDate,
      quantity: toStorageString(params.quantity),
      unitCost: toStorageString(params.unitCost),
      value: toStorageString(value),
      balanceQuantity: toStorageString(quantityAfter),
      balanceValue: toStorageString(valueAfter),
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      referenceNo: params.referenceNo ?? null,
      notes: params.notes ?? null,
      createdById: params.createdById ?? null,
    },
  });

  return { value, unitCost: money(params.unitCost), quantityAfter };
}
