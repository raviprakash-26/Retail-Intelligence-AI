import "server-only";
import { JournalStatus, Prisma, type StockMovementType } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  add,
  compare,
  money,
  multiply,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";

/**
 * What is on the shelves, what it is worth, and how it got there.
 *
 * The centrepiece is the reconciliation. Stock is recorded twice by design —
 * once as quantities in the inventory ledger and once as a rupee balance in the
 * Inventory account of the general ledger — and the two are written by
 * different code down different paths. If they ever disagree, one of them is
 * lying and every profit figure built on the cost of sales is suspect.
 *
 * So the two are compared and the answer is shown, rather than assumed. This is
 * the inventory analogue of the trial balance: cheap to compute, and the single
 * most useful thing the module can tell a retailer who is deciding whether to
 * trust their own margin.
 */

export type StockRow = {
  productId: string;
  sku: string;
  name: string;
  unitCode: string;
  categoryName: string | null;
  quantity: string;
  averageCost: string;
  stockValue: string;
  /** What it would fetch at the current selling price. */
  sellingValue: string;
  minStockLevel: string;
  /** Below the reorder level, or out entirely. */
  status: "OUT" | "LOW" | "OK";
  lastMovementAt: Date | null;
  /**
   * Discontinued, but still holding stock.
   *
   * An archived product is normally left out of this list, which is what
   * archiving is for. One still carrying stock is a different thing: the goods
   * are on the shelf and in the Inventory account, so leaving them out made the
   * stock report disagree with the balance sheet by their value. It stays until
   * the stock reaches nil, marked, so nobody has to wonder why a line they
   * discontinued is still here.
   */
  archived: boolean;
};

export type StockSummary = {
  rows: StockRow[];
  total: number;
  page: number;
  pageCount: number;
  /** Across every tracked product, not just this page. */
  totalValue: string;
  totalSellingValue: string;
  trackedProducts: number;
  outOfStock: number;
  lowStock: number;
};

export const STOCK_PAGE_SIZE = 25;

export class InventoryReportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "InventoryReportError";
  }
}

/**
 * Where a product stands, judged against its own reorder level.
 *
 * A product with no reorder level set can only ever be OUT or OK — inventing a
 * threshold for it would produce warnings nobody asked for and teach people to
 * ignore the ones that matter.
 */
function statusOf(quantity: Decimal, minimum: Decimal): StockRow["status"] {
  if (compare(quantity, 0) <= 0) return "OUT";
  if (compare(minimum, 0) > 0 && compare(quantity, minimum) <= 0) return "LOW";
  return "OK";
}

/**
 * Where every tracked product stands, before anything is filtered or paged.
 *
 * Exported because the advisor asks the same question of the same rows — what
 * is sitting still, what is about to run out — and a second implementation of
 * "what is in stock" that drifted from this one would be worse than no advice
 * at all.
 */
export async function stockRows(companyId: string): Promise<StockRow[]> {
  const products = await prisma.product.findMany({
    where: {
      companyId,
      isStockTracked: true,
      // Archiving hides a discontinued line, and should. What it must not hide
      // is stock the business still owns: the goods are on the shelf and their
      // value is in the Inventory account, so dropping them here made this
      // report disagree with the balance sheet by exactly that amount — while
      // `reconcileStock`, which reads every balance, went on reporting that the
      // two agreed. The check written to catch this could not see it, because
      // it and this list did not mean the same thing by "every product".
      OR: [
        { archivedAt: null },
        {
          inventoryBalances: {
            some: {
              OR: [{ quantity: { not: 0 } }, { stockValue: { not: 0 } }],
            },
          },
        },
      ],
    },
    select: {
      id: true,
      sku: true,
      name: true,
      sellingPrice: true,
      minStockLevel: true,
      archivedAt: true,
      unit: { select: { code: true } },
      category: { select: { name: true } },
      inventoryBalances: {
        select: { quantity: true, averageCost: true, stockValue: true },
      },
    },
    orderBy: { name: "asc" },
  });

  // Last movement per product, in one query rather than one per row.
  const lastMovements = await prisma.inventoryMovement.groupBy({
    by: ["productId"],
    where: {
      companyId,
      productId: { in: products.map((product) => product.id) },
    },
    _max: { movementDate: true },
  });
  const lastByProduct = new Map(
    lastMovements.map((row) => [row.productId, row._max.movementDate]),
  );

  return products.map((product) => {
    // A product can hold stock at several branches; the summary is the whole
    // business, so the branch positions are added together.
    const quantity = add(
      ...product.inventoryBalances.map((balance) => balance.quantity),
    );
    const stockValue = add(
      ...product.inventoryBalances.map((balance) => balance.stockValue),
    );
    const averageCost =
      compare(quantity, 0) > 0
        ? money(stockValue).dividedBy(quantity)
        : money(0);

    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unitCode: product.unit.code,
      categoryName: product.category?.name ?? null,
      quantity: toStorageString(quantity),
      averageCost: toStorageString(averageCost),
      stockValue: toStorageString(stockValue),
      sellingValue: toStorageString(multiply(quantity, product.sellingPrice)),
      minStockLevel: toStorageString(product.minStockLevel),
      status: statusOf(quantity, money(product.minStockLevel)),
      lastMovementAt: lastByProduct.get(product.id) ?? null,
      archived: product.archivedAt !== null,
    };
  });
}

export async function getStockSummary(params: {
  companyId: string;
  query?: string;
  /** "low" narrows to what needs reordering; "out" to what has run out. */
  filter?: "low" | "out";
  page?: number;
}): Promise<StockSummary> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  // Every tracked product is loaded, and the search is applied after the totals
  // are struck. The headline value is a fact about the business, not about
  // whatever somebody has typed in the search box — a figure that moves when
  // you filter a list is one nobody can quote.
  const all = await stockRows(params.companyId);

  const needle = query.toLowerCase();
  const matches = (row: StockRow) =>
    needle.length === 0 ||
    row.name.toLowerCase().includes(needle) ||
    row.sku.toLowerCase().includes(needle);

  const filtered = all
    .filter(matches)
    .filter((row) =>
      params.filter === "out"
        ? row.status === "OUT"
        : params.filter === "low"
          ? row.status !== "OK"
          : true,
    );

  const start = (page - 1) * STOCK_PAGE_SIZE;

  return {
    rows: filtered.slice(start, start + STOCK_PAGE_SIZE),
    total: filtered.length,
    page,
    pageCount: Math.max(1, Math.ceil(filtered.length / STOCK_PAGE_SIZE)),
    // Totals cover every tracked product, so the headline value does not
    // change when somebody types in the search box.
    totalValue: toStorageString(add(...all.map((row) => row.stockValue))),
    totalSellingValue: toStorageString(
      add(...all.map((row) => row.sellingValue)),
    ),
    trackedProducts: all.length,
    outOfStock: all.filter((row) => row.status === "OUT").length,
    lowStock: all.filter((row) => row.status === "LOW").length,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type StockReconciliation = {
  /** Total of the cached per-product positions. */
  ledgerValue: string;
  /** Sum of every movement's value — the append-only record. */
  movementValue: string;
  /** The Inventory account balance in the general ledger. */
  accountBalance: string;
  /** Cached positions against the movement ledger they are built from. */
  cacheDifference: string;
  /** Stock records against the accounting records. */
  accountDifference: string;
  agrees: boolean;
  /** Products whose cached position disagrees with their own movements. */
  drifted: Array<{
    productId: string;
    sku: string;
    name: string;
    cached: string;
    fromMovements: string;
  }>;
};

/**
 * Does the stock ledger agree with the books?
 *
 * Three figures that must be identical, each written by different code:
 *
 *   • the cached position on each product,
 *   • the sum of every movement ever recorded for it,
 *   • the Inventory account balance in the general ledger.
 *
 * The first two diverging means a position was written without its movement, or
 * the other way round. The third diverging means stock moved without the
 * accounting following, which is how a business ends up with a cost of sales
 * that cannot be explained.
 *
 * Nothing here repairs anything. A reconciliation that silently corrects what it
 * finds destroys the evidence of how it broke.
 *
 * **All three are read as one.** Five statements outside a transaction see the
 * database five times, and every posting path writes the position, the movement
 * and the entry together — so the books are never inconsistent, and a reader
 * that catches a sale between two of its own queries sees them so anyway. The
 * difference it then reports is the cost of goods on an invoice that was posted
 * correctly, and there is nothing to find by the time anybody looks. The auditor
 * keeps what it finds, so that lands on the record as an open HIGH finding about
 * a disagreement that never existed.
 *
 * Repeatable read fixes the reading, not the writing: one snapshot, taken at the
 * first statement, for all of them. Nothing here writes, so there is no
 * serialisation failure to retry — the isolation level buys a consistent view
 * and costs a held connection for the length of five queries.
 */
export async function reconcileStock(
  companyId: string,
): Promise<StockReconciliation> {
  return prisma.$transaction((tx) => reconcileWithin(tx, companyId), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

async function reconcileWithin(
  tx: DbClient,
  companyId: string,
): Promise<StockReconciliation> {
  // Sequential on one connection now rather than three, which is what a single
  // snapshot costs and the whole of what it costs.
  const balances = await tx.inventoryBalance.findMany({
    where: { companyId },
    select: { productId: true, stockValue: true },
  });
  const movements = await tx.inventoryMovement.groupBy({
    by: ["productId"],
    where: { companyId },
    _sum: { value: true },
  });
  const account = await tx.account.findFirst({
    where: { companyId, systemKey: SYSTEM_ACCOUNT.INVENTORY },
    select: { id: true },
  });

  const cachedByProduct = new Map<string, Decimal>();
  for (const balance of balances) {
    cachedByProduct.set(
      balance.productId,
      add(cachedByProduct.get(balance.productId) ?? 0, balance.stockValue),
    );
  }

  const movementByProduct = new Map(
    movements.map((row) => [row.productId, money(row._sum.value ?? 0)]),
  );

  const ledgerValue = add(...[...cachedByProduct.values()]);
  const movementValue = add(...[...movementByProduct.values()]);

  const accountTotals = account
    ? await tx.journalLine.aggregate({
        where: {
          companyId,
          accountId: account.id,
          status: JournalStatus.POSTED,
        },
        _sum: { debit: true, credit: true },
      })
    : { _sum: { debit: null, credit: null } };

  const accountBalance = subtract(
    accountTotals._sum.debit ?? 0,
    accountTotals._sum.credit ?? 0,
  );

  const productIds = new Set([
    ...cachedByProduct.keys(),
    ...movementByProduct.keys(),
  ]);

  const driftedIds = [...productIds].filter((productId) => {
    const cached = cachedByProduct.get(productId) ?? money(0);
    const fromMovements = movementByProduct.get(productId) ?? money(0);
    return !subtract(cached, fromMovements).isZero();
  });

  const driftedProducts = driftedIds.length
    ? await tx.product.findMany({
        where: { companyId, id: { in: driftedIds } },
        select: { id: true, sku: true, name: true },
      })
    : [];

  const cacheDifference = subtract(ledgerValue, movementValue);
  const accountDifference = subtract(ledgerValue, accountBalance);

  return {
    ledgerValue: toStorageString(ledgerValue),
    movementValue: toStorageString(movementValue),
    accountBalance: toStorageString(accountBalance),
    cacheDifference: toStorageString(cacheDifference),
    accountDifference: toStorageString(accountDifference),
    agrees: cacheDifference.isZero() && accountDifference.isZero(),
    drifted: driftedProducts.map((product) => ({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      cached: toStorageString(cachedByProduct.get(product.id) ?? 0),
      fromMovements: toStorageString(movementByProduct.get(product.id) ?? 0),
    })),
  };
}

// ---------------------------------------------------------------------------
// One product's history
// ---------------------------------------------------------------------------

export type MovementRow = {
  id: string;
  date: string;
  type: StockMovementType;
  typeLabel: string;
  /** Signed: positive inward, negative outward. */
  quantity: string;
  unitCost: string;
  value: string;
  balanceQuantity: string;
  balanceValue: string;
  referenceNo: string | null;
  notes: string | null;
  documentHref: string | null;
  branchName: string | null;
};

export type ProductStockCard = {
  product: {
    id: string;
    sku: string;
    name: string;
    unitCode: string;
    sellingPrice: string;
    minStockLevel: string;
  };
  quantity: string;
  averageCost: string;
  stockValue: string;
  movements: MovementRow[];
  total: number;
  page: number;
  pageCount: number;
};

export const MOVEMENT_LABELS: Record<StockMovementType, string> = {
  OPENING: "Opening stock",
  PURCHASE: "Bought in",
  SALE: "Sold",
  SALES_RETURN: "Returned by a customer",
  PURCHASE_RETURN: "Returned to a supplier",
  ADJUSTMENT_IN: "Counted in",
  ADJUSTMENT_OUT: "Counted out",
  TRANSFER_IN: "Moved in",
  TRANSFER_OUT: "Moved out",
  WRITE_OFF: "Written off",
};

const DOCUMENT_PATHS: Record<string, string> = {
  SALE: "/app/sales",
  PURCHASE: "/app/purchases",
};

export const MOVEMENT_PAGE_SIZE = 50;

export async function getProductStockCard(params: {
  companyId: string;
  productId: string;
  page?: number;
}): Promise<ProductStockCard> {
  const page = Math.max(1, params.page ?? 1);

  const product = await prisma.product.findFirst({
    where: { id: params.productId, companyId: params.companyId },
    select: {
      id: true,
      sku: true,
      name: true,
      sellingPrice: true,
      minStockLevel: true,
      unit: { select: { code: true } },
      inventoryBalances: {
        select: { quantity: true, averageCost: true, stockValue: true },
      },
    },
  });

  if (!product) {
    throw new InventoryReportError(
      "That product could not be found.",
      "NOT_FOUND",
    );
  }

  const where: Prisma.InventoryMovementWhereInput = {
    companyId: params.companyId,
    productId: product.id,
  };

  const [total, movements] = await Promise.all([
    prisma.inventoryMovement.count({ where }),
    prisma.inventoryMovement.findMany({
      where,
      select: {
        id: true,
        movementDate: true,
        movementType: true,
        quantity: true,
        unitCost: true,
        value: true,
        balanceQuantity: true,
        balanceValue: true,
        referenceNo: true,
        notes: true,
        sourceType: true,
        sourceId: true,
        branch: { select: { name: true } },
      },
      // Newest first: a stock card is read to answer "what happened lately".
      orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * MOVEMENT_PAGE_SIZE,
      take: MOVEMENT_PAGE_SIZE,
    }),
  ]);

  const quantity = add(
    ...product.inventoryBalances.map((balance) => balance.quantity),
  );
  const stockValue = add(
    ...product.inventoryBalances.map((balance) => balance.stockValue),
  );

  return {
    product: {
      id: product.id,
      sku: product.sku,
      name: product.name,
      unitCode: product.unit.code,
      sellingPrice: toStorageString(product.sellingPrice),
      minStockLevel: toStorageString(product.minStockLevel),
    },
    quantity: toStorageString(quantity),
    averageCost: toStorageString(
      compare(quantity, 0) > 0
        ? money(stockValue).dividedBy(quantity)
        : money(0),
    ),
    stockValue: toStorageString(stockValue),
    movements: movements.map((movement) => ({
      id: movement.id,
      date: movement.movementDate.toISOString().slice(0, 10),
      type: movement.movementType,
      typeLabel: MOVEMENT_LABELS[movement.movementType],
      quantity: toStorageString(movement.quantity),
      unitCost: toStorageString(movement.unitCost),
      value: toStorageString(movement.value),
      balanceQuantity: toStorageString(movement.balanceQuantity),
      balanceValue: toStorageString(movement.balanceValue),
      referenceNo: movement.referenceNo,
      notes: movement.notes,
      documentHref:
        movement.sourceType && movement.sourceId
          ? DOCUMENT_PATHS[movement.sourceType]
            ? `${DOCUMENT_PATHS[movement.sourceType]}/${movement.sourceId}`
            : null
          : null,
      branchName: movement.branch?.name ?? null,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / MOVEMENT_PAGE_SIZE)),
  };
}
