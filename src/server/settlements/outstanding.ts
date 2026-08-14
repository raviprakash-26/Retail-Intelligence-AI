import "server-only";
import { DocumentStatus } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { subtract, toStorageString } from "@/lib/money";
import { summariseAgeing, type AgeingSummary } from "@/lib/settlements/ageing";

/**
 * What is owed, and for how long.
 *
 * Read straight from the documents rather than from a running balance, because
 * a running balance drifts the moment anything is voided and there is nothing to
 * reconcile it against. Outstanding is total minus settled, document by
 * document, and the ageing follows from the due dates those documents carry.
 */

export type OpenDocument = {
  id: string;
  number: string;
  date: string;
  dueDate: string;
  total: string;
  paid: string;
  outstanding: string;
  daysOverdue: number;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Invoices a customer has not fully paid, oldest due first. */
export async function openInvoices(
  client: DbClient,
  params: { companyId: string; customerId: string },
): Promise<OpenDocument[]> {
  const sales = await client.sale.findMany({
    where: {
      companyId: params.companyId,
      customerId: params.customerId,
      status: DocumentStatus.POSTED,
    },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      dueDate: true,
      totalAmount: true,
      paidAmount: true,
    },
    orderBy: [{ dueDate: "asc" }, { invoiceDate: "asc" }],
  });

  const now = new Date();
  return sales
    .map((sale) => {
      const due = sale.dueDate ?? sale.invoiceDate;
      const outstanding = subtract(sale.totalAmount, sale.paidAmount);
      return {
        id: sale.id,
        number: sale.invoiceNumber,
        date: isoDay(sale.invoiceDate),
        dueDate: isoDay(due),
        total: toStorageString(sale.totalAmount),
        paid: toStorageString(sale.paidAmount),
        outstanding: toStorageString(outstanding),
        daysOverdue: Math.max(
          0,
          Math.round((now.getTime() - due.getTime()) / 86_400_000),
        ),
      };
    })
    .filter((document) => Number(document.outstanding) > 0);
}

/** Bills not fully paid, oldest due first. */
export async function openBills(
  client: DbClient,
  params: { companyId: string; supplierId: string },
): Promise<OpenDocument[]> {
  const purchases = await client.purchase.findMany({
    where: {
      companyId: params.companyId,
      supplierId: params.supplierId,
      status: DocumentStatus.POSTED,
    },
    select: {
      id: true,
      billNumber: true,
      supplierBillNo: true,
      billDate: true,
      dueDate: true,
      totalAmount: true,
      paidAmount: true,
    },
    orderBy: [{ dueDate: "asc" }, { billDate: "asc" }],
  });

  const now = new Date();
  return purchases
    .map((purchase) => {
      const due = purchase.dueDate ?? purchase.billDate;
      const outstanding = subtract(purchase.totalAmount, purchase.paidAmount);
      return {
        id: purchase.id,
        number: purchase.supplierBillNo
          ? `${purchase.billNumber} · ${purchase.supplierBillNo}`
          : purchase.billNumber,
        date: isoDay(purchase.billDate),
        dueDate: isoDay(due),
        total: toStorageString(purchase.totalAmount),
        paid: toStorageString(purchase.paidAmount),
        outstanding: toStorageString(outstanding),
        daysOverdue: Math.max(
          0,
          Math.round((now.getTime() - due.getTime()) / 86_400_000),
        ),
      };
    })
    .filter((document) => Number(document.outstanding) > 0);
}

export type PartyBalance = {
  id: string;
  name: string;
  outstanding: string;
  overdue: string;
  oldestOverdueDays: number | null;
};

export type LedgerAgeing = {
  summary: {
    total: string;
    overdue: string;
    buckets: Record<string, string>;
    oldestOverdueDays: number | null;
  };
  parties: PartyBalance[];
};

function serialise(summary: AgeingSummary) {
  return {
    total: toStorageString(summary.total),
    overdue: toStorageString(summary.overdue),
    buckets: Object.fromEntries(
      Object.entries(summary.buckets).map(([key, value]) => [
        key,
        toStorageString(value),
      ]),
    ),
    oldestOverdueDays: summary.oldestOverdueDays,
  };
}

/** Receivables: who owes the business, and how overdue each of them is. */
export async function receivablesAgeing(
  companyId: string,
): Promise<LedgerAgeing> {
  const sales = await prisma.sale.findMany({
    where: {
      companyId,
      status: DocumentStatus.POSTED,
      customerId: { not: null },
    },
    select: {
      customerId: true,
      invoiceDate: true,
      dueDate: true,
      totalAmount: true,
      paidAmount: true,
      customer: { select: { name: true } },
    },
  });

  const now = new Date();
  const documents = sales
    .map((sale) => ({
      partyId: sale.customerId ?? "",
      partyName: sale.customer?.name ?? "—",
      dueDate: sale.dueDate ?? sale.invoiceDate,
      outstanding: subtract(sale.totalAmount, sale.paidAmount),
    }))
    .filter((document) => document.outstanding.greaterThan(0));

  return {
    summary: serialise(summariseAgeing(documents, now)),
    parties: byParty(documents, now),
  };
}

/** Payables: whom the business owes. */
export async function payablesAgeing(companyId: string): Promise<LedgerAgeing> {
  const purchases = await prisma.purchase.findMany({
    where: {
      companyId,
      status: DocumentStatus.POSTED,
      supplierId: { not: null },
    },
    select: {
      supplierId: true,
      billDate: true,
      dueDate: true,
      totalAmount: true,
      paidAmount: true,
      supplier: { select: { name: true } },
    },
  });

  const now = new Date();
  const documents = purchases
    .map((purchase) => ({
      partyId: purchase.supplierId ?? "",
      partyName: purchase.supplier?.name ?? "—",
      dueDate: purchase.dueDate ?? purchase.billDate,
      outstanding: subtract(purchase.totalAmount, purchase.paidAmount),
    }))
    .filter((document) => document.outstanding.greaterThan(0));

  return {
    summary: serialise(summariseAgeing(documents, now)),
    parties: byParty(documents, now),
  };
}

function byParty(
  documents: ReadonlyArray<{
    partyId: string;
    partyName: string;
    dueDate: Date;
    outstanding: { toFixed: (n: number) => string };
  }>,
  now: Date,
): PartyBalance[] {
  const grouped = new Map<string, { name: string; rows: typeof documents }>();
  for (const document of documents) {
    const existing = grouped.get(document.partyId);
    if (existing) {
      existing.rows = [...existing.rows, document];
    } else {
      grouped.set(document.partyId, {
        name: document.partyName,
        rows: [document],
      });
    }
  }

  return [...grouped.entries()]
    .map(([id, entry]) => {
      const summary = summariseAgeing(entry.rows, now);
      return {
        id,
        name: entry.name,
        outstanding: toStorageString(summary.total),
        overdue: toStorageString(summary.overdue),
        oldestOverdueDays: summary.oldestOverdueDays,
      };
    })
    .sort((a, b) => Number(b.outstanding) - Number(a.outstanding));
}
