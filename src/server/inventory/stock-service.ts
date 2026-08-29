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
  divide,
  money,
  subtract,
  toStorageString,
  type MoneyInput,
} from "@/lib/money";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";

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
      // The branch as given, null included. Null is a position of its own —
      // the balance is looked up on it exactly, opening stock is placed on the
      // primary branch, and a member invited without one posts here — so a
      // query that dropped the filter when it was null pooled every branch's
      // movements into it. One function then answered "what is here" two ways:
      // the balance from this branch and the layers from all of them, which is
      // how a sale came to be allowed against stock another branch was
      // holding.
      branchId: params.branchId,
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

/**
 * Holds the company's stock still for the rest of the transaction.
 *
 * Recording a movement reads the balance, works the new one out here and writes
 * it back. Under the default isolation a second transaction reads the same
 * starting figure before the first has committed, computes its answer from a
 * number already stale, and overwrites it. The movement rows are inserts and
 * every one of them survives, so the ledger stays right and only the cached
 * position loses them — which is precisely the disagreement `reconcileStock`
 * exists to report, arriving with nothing to explain it.
 *
 * Two sales cannot do this to each other, which is worth saying because it is
 * the obvious guess: a sale allocates an invoice number first, that takes a row
 * lock on the company's sale sequence, and the second sale waits there. It is
 * the paths that share no sequence that race — a sale against a delivery being
 * booked in, either against an adjustment, which takes no document number.
 *
 * Per company rather than per product, and deliberately. Every path touches
 * stock after its document number and before its journal number, so one lock
 * taken at that point gives a single order — document sequence, then stock,
 * then journal sequence — that no path can take the other way round. A
 * per-product lock would be finer and would oblige every caller to take a
 * document's lines in a fixed order to stay safe; a shop posts a handful of
 * stock movements a minute, and serialising those is not a cost it can measure.
 *
 * **The calendar is settled before the lock is taken, and that order is the
 * whole reason this function does two things.** `ensureFiscalYearFor` holds an
 * advisory lock of its own while it opens a fiscal year the calendar has not
 * reached yet, and it too is held to commit. A sale meets it early — it needs a
 * year to hang the invoice number off — so a sale's order is calendar, then
 * stock. An adjustment takes no document number, so nothing made it think about
 * the calendar until `postJournalEntry` settled the year on its way past: stock,
 * then calendar. Two orders is a cycle, and the cycle is a deadlock Postgres
 * resolves by aborting one of them — on the first morning of a new fiscal year,
 * which is the one morning the calendar lock is ever contended, and precisely
 * the morning `fiscal-calendar` describes when it explains why that lock exists.
 * Settling the calendar here means no caller can arrive holding stock and
 * wanting a year, whatever it did before it got here.
 *
 * The date is the movement's own, which is the date its journal entry carries
 * on every path that posts one — so this opens no year that was not about to be
 * opened a few statements later, and refuses the same dates `postJournalEntry`
 * would have refused.
 *
 * Transaction-scoped, so both are released on commit or rollback without
 * anything having to remember to.
 */
async function lockStock(
  tx: DbClient,
  params: { companyId: string; movementDate: Date },
): Promise<void> {
  await ensureFiscalYearFor(tx, {
    companyId: params.companyId,
    date: params.movementDate,
  });

  // `$executeRaw` rather than `$queryRaw`: the lock function returns void, and
  // asking for rows back from it fails to deserialise.
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`stock:${params.companyId}`}, 0))
  `;
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

/**
 * What each of several products holds at one branch.
 *
 * The batched form of the quantity `readPosition` returns, for a picker that
 * has just matched twenty products and has to show a figure beside each of
 * them.
 *
 * **The branch is a parameter rather than a filter that can be left off**, and
 * that is the whole reason this exists. Stock is held per branch; `recordOutward`
 * reads the position at the branch a sale is posting to and refuses to go below
 * nil *there*. The invoice form was adding every branch's balance together, so
 * the badge beside a product, the shortage warning under the line and the
 * refusal on submit were three answers to one question, and only the last of
 * them was about the shelf the goods were coming off.
 *
 * A product with no balance row at this branch is absent from the map. A caller
 * reads that as nil, which is what an empty shelf is.
 */
export async function branchQuantities(
  client: DbClient,
  params: {
    companyId: string;
    branchId: string | null;
    productIds: readonly string[];
  },
): Promise<Map<string, Decimal>> {
  if (params.productIds.length === 0) return new Map();

  const balances = await client.inventoryBalance.findMany({
    where: {
      companyId: params.companyId,
      // Exactly this branch, null included — the same lookup `readPosition`
      // does, and for the reason given there: null is a position of its own.
      branchId: params.branchId,
      productId: { in: [...params.productIds] },
    },
    select: { productId: true, quantity: true },
  });

  return new Map(
    balances.map((balance) => [balance.productId, money(balance.quantity)]),
  );
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
 * Raised when a movement is asked to remove more value than the shelf holds.
 *
 * Only reachable with an explicit `cost`. What the valuation method works out
 * for itself is a share of the position and can never exceed it.
 */
export class InsufficientStockValueError extends Error {
  constructor(
    readonly available: Decimal,
    readonly requested: Decimal,
  ) {
    super(
      `The position holds ${available.toString()}; ${requested.toString()} was asked for.`,
    );
    this.name = "InsufficientStockValueError";
  }
}

/**
 * Takes stock out and reports what it cost.
 *
 * Refuses to go negative. Stock the business does not have cannot have a cost,
 * so allowing it would post a fabricated cost of goods sold and leave a
 * negative asset on the balance sheet — the invoice would look fine and the
 * accounts would be wrong.
 *
 * **`cost` is for un-recording, and only for that.** Stock leaving in the
 * ordinary way is worth whatever the method says the position is worth, and no
 * caller gets to have an opinion about that — a sale cannot decide what its own
 * goods cost. Undoing a document is not stock leaving, though: a void says the
 * receipt never happened, so what comes off is what that receipt put on, and the
 * pooled rate is the wrong question. Without it `voidPurchase` took units back
 * at today's average while its reversal credited what the bill had said, and the
 * two parted company by the difference.
 */
export async function recordOutward(
  tx: DbClient,
  params: {
    companyId: string;
    productId: string;
    branchId: string | null;
    method: InventoryMethod;
    quantity: MoneyInput;
    /** What this movement is worth, when undoing one that named its own value. */
    cost?: MoneyInput;
    movementType: StockMovementType;
    movementDate: Date;
    sourceType: string;
    sourceId: string;
    referenceNo?: string | null;
    notes?: string | null;
    createdById?: string | null;
  },
): Promise<MovementResult> {
  await lockStock(tx, {
    companyId: params.companyId,
    movementDate: params.movementDate,
  });
  const position = await readPosition(tx, params);

  // Run even when the cost is given, for the quantity guard it carries.
  const consumption = consume(params.method, {
    onHandQuantity:
      params.method === "FIFO"
        ? layersQuantity(position.layers)
        : position.quantity,
    onHandValue: position.stockValue,
    layers: position.layers,
    quantity: params.quantity,
  });

  const quantityAfter = subtract(position.quantity, params.quantity);

  if (params.cost !== undefined) {
    const asked = money(params.cost);
    // The quantity can be there while the value is not: units sold in between
    // took their share of the pool with them, and what is left may be worth
    // less than the receipt being undone. Taking it anyway would leave a
    // negative asset, which is the thing this function exists to refuse.
    if (asked.greaterThan(position.stockValue)) {
      throw new InsufficientStockValueError(position.stockValue, asked);
    }
  }

  // A shelf sold down to nothing is worth nothing, whatever the method makes of
  // the units.
  //
  // Weighted average reaches this on its own now that it takes a share of the
  // pool's value. FIFO cannot: its layers are rebuilt from the movement ledger
  // and carry a *rounded* unit cost, so a receipt of three units at ₹89.99
  // becomes a layer of three at ₹29.9967 and costs ₹89.9901 to clear. The pool
  // is what the books hold and the layers are a reconstruction of it, so where
  // the two disagree the pool is right.
  const cost =
    params.cost !== undefined
      ? money(params.cost)
      : quantityAfter.isZero()
        ? position.stockValue
        : consumption.cost;
  const unitCost = money(params.quantity).isZero()
    ? money(0)
    : divide(cost, params.quantity);
  const valueAfter = subtract(position.stockValue, cost);

  await writeBalance(tx, {
    companyId: params.companyId,
    productId: params.productId,
    branchId: params.branchId,
    quantity: quantityAfter,
    // The average is what is left, over what is left of it.
    //
    // For stock leaving in the ordinary way this changes nothing — value goes
    // out at the pooled rate, so the ratio it came from is the ratio it leaves
    // behind — and it used to be spelled that way, as "weighted average is
    // unchanged by an outward movement" with only FIFO recomputing. That stops
    // being true the moment a caller names its own cost: undoing a ₹300 receipt
    // from six units holding ₹360 leaves three units holding ₹60, and an
    // average still reading ₹60 describes a shelf worth ₹180 that is not there.
    averageCost: quantityAfter.greaterThan(0)
      ? divide(valueAfter, quantityAfter)
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
      unitCost: toStorageString(unitCost),
      value: toStorageString(cost.negated()),
      balanceQuantity: toStorageString(quantityAfter),
      balanceValue: toStorageString(valueAfter),
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      referenceNo: params.referenceNo ?? null,
      notes: params.notes ?? null,
      createdById: params.createdById ?? null,
    },
  });

  return { value: cost, unitCost, quantityAfter };
}

/**
 * Puts stock in at a known cost, blending the weighted average.
 *
 * **The cost is the total, not the rate.** A per-unit figure is four decimal
 * places wide, and a caller that has a total has to divide by the quantity to
 * get one — a division that does not always multiply back. A bill for three
 * units of ₹89.99 gives ₹29.9967 each and ₹89.9901 back, so the Inventory
 * account was debited with what the bill said and the stock ledger recorded a
 * hundredth of a paisa more. The two are one fact, and `reconcileStock` compares
 * them with no tolerance and is right to: the difference raises a HIGH finding
 * that says stock and books disagree, on an ordinary bill, and nothing the shop
 * can do will clear it.
 *
 * So the total comes in whole and the rate is derived from it here, for the
 * movement's own column and for the average. `createPurchaseReturn` states the
 * rule from the other side — "the Inventory account has to match the stock
 * ledger" — and takes what the ledger gave up rather than what the bill said.
 */
export async function recordInward(
  tx: DbClient,
  params: {
    companyId: string;
    productId: string;
    branchId: string | null;
    method: InventoryMethod;
    quantity: MoneyInput;
    /** What these goods cost in total. */
    cost: MoneyInput;
    movementType: StockMovementType;
    movementDate: Date;
    sourceType: string;
    sourceId: string;
    referenceNo?: string | null;
    notes?: string | null;
    createdById?: string | null;
  },
): Promise<MovementResult> {
  await lockStock(tx, {
    companyId: params.companyId,
    movementDate: params.movementDate,
  });
  const position = await readPosition(tx, params);

  const value = money(params.cost);
  const quantityAfter = add(position.quantity, params.quantity);
  const valueAfter = add(position.stockValue, value);
  const unitCost = money(params.quantity).isZero()
    ? money(0)
    : divide(value, params.quantity);

  const averageCost = blendAverageCost({
    onHandQuantity: position.quantity,
    onHandValue: position.stockValue,
    averageCost: position.averageCost,
    inwardQuantity: params.quantity,
    inwardValue: value,
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
      unitCost: toStorageString(unitCost),
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

  return { value, unitCost, quantityAfter };
}
