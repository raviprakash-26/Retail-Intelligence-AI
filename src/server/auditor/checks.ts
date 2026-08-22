import "server-only";
import {
  DocumentStatus,
  GstRegistrationType,
  JournalStatus,
  VoucherType,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  add,
  compare,
  isNegative,
  money,
  PRESENTATION_SCALE,
  subtract,
} from "@/lib/money";
import { CASH_PAYMENT_LIMIT } from "@/lib/tax/presumptive";
import { RULES, type RuleKey, type Severity } from "@/lib/auditor/rules";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { getGstWorkingPaper } from "@/server/gst/gst-return-service";
import { reconcileStock } from "@/server/inventory/inventory-report";
import { settledByNotes } from "@/server/settlements/outstanding";
import { aggregateCashDays, cashOutflows } from "@/server/tax/cash-outflows";

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
 * The first day inside the audited period that cash closes below zero.
 *
 * A running balance in the database rather than in JavaScript: a busy shop's
 * cash account is tens of thousands of lines, and the question is only "did it
 * go under", which SQL answers without moving any of them.
 *
 * Two dates matter here and they are not the same one. The balance has to
 * accumulate from the **beginning of the books**, because a drawer's position
 * today is the sum of everything that ever went through it — starting the
 * running total at the period opening would report a shop as overdrawn for
 * every period that begins mid-month. But only days **inside the audited
 * window** are reported: an audit of this quarter that surfaces a day in a
 * quarter nobody asked about is answering a different question, and the finding
 * reappears on every run forever because the past does not change.
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
        -- Everything up to the end of the window: the balance on a day is the
        -- whole history behind it, so the period opening is not a floor here.
        AND l."entryDate" <= ${context.to}
      GROUP BY 1
    ),
    running AS (
      SELECT day, SUM(movement) OVER (ORDER BY day) AS running
      FROM daily
    )
    SELECT day, running
    FROM running
    -- Reported only for days the audit was asked about.
    WHERE day >= ${context.from}
    ORDER BY day
  `;

  const negative = rows.filter((row) => isNegative(row.running.toString()));
  const firstNegative = negative[0];
  if (!firstNegative) return [];

  const lowest = negative.reduce((worst, row) =>
    compare(row.running.toString(), worst.running.toString()) < 0 ? row : worst,
  );

  return [
    finding("NEGATIVE_CASH_BALANCE", {
      firstDate: isoDay(firstNegative.day),
      balanceThatDay: firstNegative.running.toString(),
      lowestDate: isoDay(lowest.day),
      lowestBalance: lowest.running.toString(),
      daysBelowZero: negative.length,
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
// Tax
// ---------------------------------------------------------------------------

/** The months an audit window touches, oldest first. */
function monthsBetween(
  from: Date,
  to: Date,
): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1),
  );
  const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));

  // Bounded so a window opened by a typo — a from-date in 1970 — walks a
  // sensible number of periods rather than a thousand.
  while (cursor <= last && months.length < MAX_GST_PERIODS) {
    months.push({
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/** How many monthly periods one audit will cross-check. */
const MAX_GST_PERIODS = 24;

/**
 * The tax register against the ledger, month by month.
 *
 * This rule was in the catalogue from the start and nothing produced it — the
 * one check a GST-registered shop would most want was advertised and absent.
 * The comparison itself already existed behind the GST working paper, which
 * computes both figures for its own reconciliation panel; this reads that
 * rather than recomputing it, so the auditor and the GST page cannot disagree.
 *
 * Businesses that do not file this return are skipped rather than passed:
 * composition dealers and unregistered shops have no output tax to reconcile,
 * and a finding about a return they never file is noise.
 */
async function checkGstRegister(context: CheckContext): Promise<Finding[]> {
  const company = await prisma.company.findUnique({
    where: { id: context.companyId },
    select: { gstRegistration: true },
  });

  if (
    company?.gstRegistration !== GstRegistrationType.REGULAR &&
    company?.gstRegistration !== GstRegistrationType.SEZ
  ) {
    return [];
  }

  const findings: Finding[] = [];

  for (const period of monthsBetween(context.from, context.to)) {
    const paper = await getGstWorkingPaper({
      companyId: context.companyId,
      year: period.year,
      month: period.month,
    });

    // A month with no documents has nothing to disagree about.
    if (paper.empty || paper.reconciliation.agrees) continue;

    findings.push(
      finding("GST_REGISTER_MISMATCH", {
        period: paper.label,
        outputFromRegister: paper.reconciliation.outputFromRegister,
        outputFromLedger: paper.reconciliation.outputFromLedger,
        outputDifference: paper.reconciliation.outputDifference,
        inputFromRegister: paper.reconciliation.inputFromRegister,
        inputFromLedger: paper.reconciliation.inputFromLedger,
        inputDifference: paper.reconciliation.inputDifference,
      }),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Cash paid to one person in one day, above the section 40A(3) limit.
 *
 * This used to be a query of its own over expenses and payment vouchers,
 * grouped by whatever name was on the voucher. It missed the most ordinary way
 * a shop pays cash to a supplier — a bill settled at the counter, which has no
 * payment voucher because the amount sits on the bill itself. The rule's own
 * example is that case: "a supplier who does not take bank transfers was paid
 * for a large delivery". The income tax working paper had always counted it and
 * disallowed it, so the two halves of the product disagreed about the same law:
 * the computation took the deduction away, and the check that exists to warn
 * about it before the year ends said nothing.
 *
 * It now asks the same code the computation does. Same three sources, and the
 * same key — the party a payment went to rather than the spelling on a voucher,
 * so two spellings of one supplier are one person and two unnamed payees are
 * not.
 *
 * Capital payments are left out here and not there, deliberately: they are
 * caught by the proviso to section 43(1), which denies them a place in the cost
 * of the asset rather than disallowing a year's expenditure. Different
 * provision, different consequence, and this rule names 40A(3).
 */
async function checkCashOverLimit(context: CheckContext): Promise<Finding[]> {
  const outflows = await cashOutflows({
    companyId: context.companyId,
    from: context.from,
    to: context.to,
  });

  return aggregateCashDays(outflows)
    .filter((day) => !day.capital)
    .slice(0, 20)
    .map((day) =>
      finding("CASH_PAYMENT_OVER_LIMIT", {
        paidTo: day.partyName,
        date: day.date,
        total: day.amount,
        limit: CASH_PAYMENT_LIMIT,
        vouchers: day.vouchers,
      }),
    );
}

/** Days past due at which an unpaid invoice is worth surfacing. */
const LONG_OVERDUE_DAYS = 90;

/**
 * Money owed for a long time.
 *
 * Two things this has to get right, and it used to get neither.
 *
 * **Every matching invoice, not a page of them.** It once took the first fifty
 * overdue invoices and added those up, so a shop with two hundred was shown the
 * outstanding of fifty presented as the whole — a figure that was wrong, looked
 * exact, and got smaller the worse the problem was. Every overdue invoice is
 * read here, with no page bound; the earlier fault was summing a page, not
 * summing outside the database.
 *
 * **What an invoice still owes, not what was receipted against it.** Asking
 * whether `totalAmount > paidAmount` is what settled meant before returns
 * existed. A credit note settles an invoice as surely as a receipt does, so an
 * invoice whose goods had all come back and been credited still read as unpaid:
 * counted among those owed for over ninety days, added into the total, and
 * eligible to be named as the oldest. The auditor told a shop to chase a
 * customer for goods that customer had already sent back.
 *
 * `settledByNotes` is the definition the ageing report, the receipt form's
 * allocation cap, the cash projection, the income tax working paper and both
 * document lists already share, and it answers from the movement the return
 * posted to the receivable account — which is what tells a return credited to
 * the account apart from one refunded over the counter.
 */
async function checkLongOverdue(context: CheckContext): Promise<Finding[]> {
  const cutoff = new Date(
    context.to.getTime() - LONG_OVERDUE_DAYS * 86_400_000,
  );

  const overdue = await prisma.sale.findMany({
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
  });
  if (overdue.length === 0) return [];

  const credited = await settledByNotes(prisma, {
    companyId: context.companyId,
    documentIds: overdue.map((sale) => sale.id),
    side: "RECEIVABLE",
  });

  const stillOwed = overdue
    .map((sale) => ({
      sale,
      outstanding: subtract(
        sale.totalAmount,
        add(sale.paidAmount, credited.get(sale.id) ?? money(0)),
      ),
    }))
    .filter((entry) => compare(entry.outstanding, 0) > 0);

  if (stillOwed.length === 0) return [];

  // Oldest by invoice date among those that still owe something — the list is
  // already in that order, so the first one is it.
  const oldest = stillOwed[0]!.sale;

  return [
    finding("LONG_OVERDUE_RECEIVABLE", {
      invoices: stillOwed.length,
      outstanding: add(...stillOwed.map((entry) => entry.outstanding)).toFixed(
        PRESENTATION_SCALE,
      ),
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
  { name: "gst", run: checkGstRegister },
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
