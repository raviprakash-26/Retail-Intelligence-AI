import "server-only";
import {
  DocumentStatus,
  JournalStatus,
  VoucherType,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { CASH_PAYMENT_LIMIT } from "@/lib/tax/presumptive";
import { RULES, type RuleKey, type Severity } from "@/lib/auditor/rules";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { reconcileStock } from "@/server/inventory/inventory-report";

/**
 * The checks themselves.
 *
 * Each one is a query over posted entries, and each returns findings or
 * nothing. There is no model anywhere in this file: what is found, how bad it
 * is, and what is said about it are all decided by code that can be read.
 *
 * Every finding carries evidence — the rows, dates and amounts that made the
 * rule fire — so the reader can go and look rather than take it on trust. A
 * finding nobody can verify is an accusation, and this module is built not to
 * make those.
 */

export type Finding = {
  ruleKey: RuleKey;
  severity: Severity;
  title: string;
  description: string;
  /** What made the rule fire, in a shape the interface can render. */
  evidence: Record<string, unknown>;
  entityType: string | null;
  entityId: string | null;
};

export type CheckContext = {
  companyId: string;
  from: Date;
  to: Date;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

function finding(
  ruleKey: RuleKey,
  evidence: Record<string, unknown>,
  entity?: { type: string; id: string | null },
): Finding {
  const rule = RULES[ruleKey];
  return {
    ruleKey,
    severity: rule.severity,
    title: rule.title,
    description: rule.description,
    evidence,
    entityType: entity?.type ?? null,
    entityId: entity?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// The ledger itself
// ---------------------------------------------------------------------------

async function checkLedgerBalances(context: CheckContext): Promise<Finding[]> {
  const trial = await getTrialBalance({
    companyId: context.companyId,
    to: isoDay(context.to),
  });
  if (trial.balanced) return [];

  return [
    finding("LEDGER_OUT_OF_BALANCE", {
      totalDebit: trial.totalDebit,
      totalCredit: trial.totalCredit,
      difference: trial.difference,
      asOf: isoDay(context.to),
    }),
  ];
}

type DayRow = { day: Date; running: Prisma.Decimal };

/**
 * The first day the cash account closes below zero.
 *
 * A running balance in the database rather than in JavaScript: a busy shop's
 * cash account is tens of thousands of lines, and the question is only "did it
 * ever go under", which SQL answers without moving any of them.
 */
async function checkNegativeCash(context: CheckContext): Promise<Finding[]> {
  const rows = await prisma.$queryRaw<DayRow[]>`
    WITH daily AS (
      SELECT l."entryDate" AS day,
             SUM(l.debit - l.credit) AS movement
      FROM journal_lines l
      JOIN accounts a ON a.id = l."accountId"
      WHERE l."companyId" = ${context.companyId}::uuid
        AND l.status = ${JournalStatus.POSTED}::"JournalStatus"
        AND a."systemKey" = ${SYSTEM_ACCOUNT.CASH}
      GROUP BY 1
    )
    SELECT day, SUM(movement) OVER (ORDER BY day) AS running
    FROM daily
    ORDER BY day
  `;

  const firstNegative = rows.find((row) => Number(row.running) < 0);
  if (!firstNegative) return [];

  const lowest = rows.reduce((worst, row) =>
    Number(row.running) < Number(worst.running) ? row : worst,
  );

  return [
    finding("NEGATIVE_CASH_BALANCE", {
      firstDate: isoDay(firstNegative.day),
      balanceThatDay: firstNegative.running.toString(),
      lowestDate: isoDay(lowest.day),
      lowestBalance: lowest.running.toString(),
      daysBelowZero: rows.filter((row) => Number(row.running) < 0).length,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

async function checkStock(context: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];

  const negative = await prisma.inventoryBalance.findMany({
    where: { companyId: context.companyId, quantity: { lt: 0 } },
    select: {
      quantity: true,
      product: { select: { id: true, sku: true, name: true } },
    },
    take: 20,
  });

  for (const row of negative) {
    findings.push(
      finding(
        "NEGATIVE_STOCK",
        {
          product: row.product.name,
          sku: row.product.sku,
          quantity: row.quantity.toString(),
        },
        { type: "product", id: row.product.id },
      ),
    );
  }

  const reconciliation = await reconcileStock(context.companyId);
  if (!reconciliation.agrees) {
    findings.push(
      finding("STOCK_LEDGER_MISMATCH", {
        // The three-way check the inventory page shows: cached positions
        // against the movements they are built from, and both against the
        // Inventory account in the general ledger.
        fromMovements: reconciliation.movementValue,
        fromPositions: reconciliation.ledgerValue,
        fromLedgerAccount: reconciliation.accountBalance,
        cacheDifference: reconciliation.cacheDifference,
        accountDifference: reconciliation.accountDifference,
        driftedProducts: reconciliation.drifted.length,
      }),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

type DuplicateRow = {
  customerId: string | null;
  invoiceDate: Date;
  totalAmount: Prisma.Decimal;
  copies: bigint;
  numbers: string[];
  name: string | null;
};

async function checkDuplicateInvoices(
  context: CheckContext,
): Promise<Finding[]> {
  const rows = await prisma.$queryRaw<DuplicateRow[]>`
    SELECT s."customerId", s."invoiceDate", s."totalAmount",
           COUNT(*)::bigint AS copies,
           ARRAY_AGG(s."invoiceNumber" ORDER BY s."invoiceNumber") AS numbers,
           MAX(c.name) AS name
    FROM sales s
    LEFT JOIN customers c ON c.id = s."customerId"
    WHERE s."companyId" = ${context.companyId}::uuid
      AND s.status = ${DocumentStatus.POSTED}::"DocumentStatus"
      AND s."invoiceDate" >= ${context.from}
      AND s."invoiceDate" <= ${context.to}
      AND s."customerId" IS NOT NULL
    GROUP BY s."customerId", s."invoiceDate", s."totalAmount"
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `;

  return rows.map((row) =>
    finding(
      "DUPLICATE_INVOICE_SAME_DAY",
      {
        customer: row.name ?? "Unnamed customer",
        date: isoDay(row.invoiceDate),
        amount: row.totalAmount.toString(),
        copies: Number(row.copies),
        invoiceNumbers: row.numbers,
      },
      { type: "customer", id: row.customerId },
    ),
  );
}

type BelowCostRow = {
  invoiceNumber: string;
  invoiceDate: Date;
  saleId: string;
  name: string;
  rate: Prisma.Decimal;
  unitCost: Prisma.Decimal;
};

async function checkSalesBelowCost(context: CheckContext): Promise<Finding[]> {
  const rows = await prisma.$queryRaw<BelowCostRow[]>`
    SELECT s."invoiceNumber", s."invoiceDate", s.id AS "saleId",
           p.name, si.rate, si."unitCost"
    FROM sale_items si
    JOIN sales s    ON s.id = si."saleId"
    JOIN products p ON p.id = si."productId"
    WHERE si."companyId" = ${context.companyId}::uuid
      AND s.status = ${DocumentStatus.POSTED}::"DocumentStatus"
      AND s."invoiceDate" >= ${context.from}
      AND s."invoiceDate" <= ${context.to}
      AND si."unitCost" > 0
      AND si.rate < si."unitCost"
    ORDER BY (si."unitCost" - si.rate) DESC
    LIMIT 20
  `;

  return rows.map((row) =>
    finding(
      "SALE_BELOW_COST",
      {
        invoice: row.invoiceNumber,
        date: isoDay(row.invoiceDate),
        product: row.name,
        soldAt: row.rate.toString(),
        cost: row.unitCost.toString(),
      },
      { type: "sale", id: row.saleId },
    ),
  );
}

/** How long after its own date a document counts as caught up rather than kept. */
const BACKDATED_DAYS = 30;

type BackdatedRow = { late: bigint; worst: number | null };

async function checkBackdatedEntries(
  context: CheckContext,
): Promise<Finding[]> {
  const rows = await prisma.$queryRaw<BackdatedRow[]>`
    SELECT COUNT(*)::bigint AS late,
           MAX(DATE_PART('day', e."createdAt" - e."entryDate"))::int AS worst
    FROM journal_entries e
    WHERE e."companyId" = ${context.companyId}::uuid
      AND e.status = ${JournalStatus.POSTED}::"JournalStatus"
      AND e."entryDate" >= ${context.from}
      AND e."entryDate" <= ${context.to}
      -- An opening balance carries the first day of the year and is entered
      -- whenever the business signs up, so it is late by construction. Counting
      -- it would fire this rule on every new shop on its first day, which is
      -- exactly how a findings list teaches people to ignore it.
      AND e."voucherType" NOT IN (
        ${VoucherType.OPENING_BALANCE}::"VoucherType",
        ${VoucherType.CLOSING_ENTRY}::"VoucherType"
      )
      AND e."createdAt" - e."entryDate" > ${`${BACKDATED_DAYS} days`}::interval
  `;

  const row = rows[0];
  const late = Number(row?.late ?? 0);
  if (late === 0) return [];

  return [
    finding("BACKDATED_ENTRY", {
      entries: late,
      thresholdDays: BACKDATED_DAYS,
      longestGapDays: row?.worst ?? null,
    }),
  ];
}

/** The share of documents voided above which the volume is worth a note. */
const VOID_RATE_THRESHOLD = 0.1;

async function checkVoidRate(context: CheckContext): Promise<Finding[]> {
  const window = { gte: context.from, lte: context.to };
  const [posted, voided] = await Promise.all([
    prisma.sale.count({
      where: {
        companyId: context.companyId,
        invoiceDate: window,
        status: DocumentStatus.POSTED,
      },
    }),
    prisma.sale.count({
      where: {
        companyId: context.companyId,
        invoiceDate: window,
        status: DocumentStatus.VOIDED,
      },
    }),
  ]);

  const total = posted + voided;
  // Below a handful of documents a single void is most of the period, and a
  // finding about that would be noise rather than information.
  if (total < 10 || voided === 0) return [];
  const rate = voided / total;
  if (rate <= VOID_RATE_THRESHOLD) return [];

  return [
    finding("HIGH_VOID_RATE", {
      voided,
      posted,
      sharePercent: Number((rate * 100).toFixed(1)),
    }),
  ];
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

type CashDayRow = {
  payee: string | null;
  day: Date;
  total: Prisma.Decimal;
  vouchers: string[];
};

async function checkCashOverLimit(context: CheckContext): Promise<Finding[]> {
  const rows = await prisma.$queryRaw<CashDayRow[]>`
    SELECT payee, day, SUM(amount) AS total,
           ARRAY_AGG(voucher ORDER BY voucher) AS vouchers
    FROM (
      SELECT COALESCE(e."payeeName", 'Unnamed payee') AS payee,
             e."expenseDate" AS day, e."totalAmount" AS amount,
             e."voucherNumber" AS voucher
      FROM expenses e
      WHERE e."companyId" = ${context.companyId}::uuid
        AND e.status = ${DocumentStatus.POSTED}::"DocumentStatus"
        AND e."paymentMode" = 'CASH'
        AND e."isCapitalExpenditure" = false
        AND e."expenseDate" BETWEEN ${context.from} AND ${context.to}

      UNION ALL

      SELECT COALESCE(sup.name, p.purpose) AS payee,
             p."paymentDate" AS day, p.amount, p."voucherNumber" AS voucher
      FROM payments p
      LEFT JOIN suppliers sup ON sup.id = p."supplierId"
      WHERE p."companyId" = ${context.companyId}::uuid
        AND p.status = ${DocumentStatus.POSTED}::"DocumentStatus"
        AND p."paymentMode" = 'CASH'
        AND p.purpose <> 'DRAWINGS'
        AND p."paymentDate" BETWEEN ${context.from} AND ${context.to}
    ) AS cash
    GROUP BY payee, day
    HAVING SUM(amount) > ${CASH_PAYMENT_LIMIT}
    ORDER BY SUM(amount) DESC
    LIMIT 20
  `;

  return rows.map((row) =>
    finding("CASH_PAYMENT_OVER_LIMIT", {
      paidTo: row.payee ?? "Unnamed payee",
      date: isoDay(row.day),
      total: row.total.toString(),
      limit: CASH_PAYMENT_LIMIT,
      vouchers: row.vouchers,
    }),
  );
}

/** Days past due at which an unpaid invoice is worth surfacing. */
const LONG_OVERDUE_DAYS = 90;

async function checkLongOverdue(context: CheckContext): Promise<Finding[]> {
  const cutoff = new Date(
    context.to.getTime() - LONG_OVERDUE_DAYS * 86_400_000,
  );

  const sales = await prisma.sale.findMany({
    where: {
      companyId: context.companyId,
      status: DocumentStatus.POSTED,
      customerId: { not: null },
      OR: [
        { dueDate: { lt: cutoff } },
        { dueDate: null, invoiceDate: { lt: cutoff } },
      ],
    },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      dueDate: true,
      totalAmount: true,
      paidAmount: true,
      customer: { select: { name: true } },
    },
    orderBy: { invoiceDate: "asc" },
    take: 50,
  });

  const open = sales.filter(
    (sale) => Number(sale.totalAmount) - Number(sale.paidAmount) > 0,
  );
  if (open.length === 0) return [];

  const outstanding = open.reduce(
    (sum, sale) => sum + Number(sale.totalAmount) - Number(sale.paidAmount),
    0,
  );
  const oldest = open[0]!;

  return [
    finding("LONG_OVERDUE_RECEIVABLE", {
      invoices: open.length,
      outstanding: outstanding.toFixed(2),
      thresholdDays: LONG_OVERDUE_DAYS,
      oldestInvoice: oldest.invoiceNumber,
      oldestCustomer: oldest.customer?.name ?? "Unnamed customer",
      oldestDate: isoDay(oldest.dueDate ?? oldest.invoiceDate),
    }),
  ];
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

type Check = (context: CheckContext) => Promise<Finding[]>;

/**
 * Every check, in the order a person would want to read them.
 *
 * Exported so a test can assert the suite is complete rather than trusting
 * that a check added to the file was also wired in.
 */
export const CHECKS: ReadonlyArray<{ name: string; run: Check }> = [
  { name: "ledger", run: checkLedgerBalances },
  { name: "cash", run: checkNegativeCash },
  { name: "stock", run: checkStock },
  { name: "duplicates", run: checkDuplicateInvoices },
  { name: "belowCost", run: checkSalesBelowCost },
  { name: "cashLimit", run: checkCashOverLimit },
  { name: "voids", run: checkVoidRate },
  { name: "backdated", run: checkBackdatedEntries },
  { name: "overdue", run: checkLongOverdue },
];

/**
 * Runs every check and gathers what they found.
 *
 * A check that fails does not take the run down with it. An audit that returns
 * nothing because one query errored is worse than one that returns eight
 * results and says the ninth could not be completed.
 */
export async function runChecks(context: CheckContext): Promise<{
  findings: Finding[];
  failed: string[];
}> {
  const findings: Finding[] = [];
  const failed: string[] = [];

  for (const check of CHECKS) {
    try {
      findings.push(...(await check.run(context)));
    } catch {
      failed.push(check.name);
    }
  }

  return { findings, failed };
}
