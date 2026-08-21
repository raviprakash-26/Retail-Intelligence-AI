import "server-only";
import { DocumentStatus, JournalStatus, PartyType } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  add,
  money,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";
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

/**
 * What credit and debit notes have already taken off each document.
 *
 * "Total minus settled" above was written when a payment was the only way an
 * invoice got settled. A return is another: crediting four thousand rupees of
 * goods back to a customer's account settles four thousand rupees of what they
 * owe, exactly as a receipt would. Nothing subtracted it, so the ageing went on
 * reporting the whole invoice while the receivable account behind it had
 * already come down — the subsidiary ledger and its control account disagreeing
 * by the value of every credit note ever raised. A shop reading that chases a
 * customer for money the books do not say they owe.
 *
 * **Read from the entry the return posted, not from its total.** A return
 * credited to the customer's account reduces what they owe; a return refunded
 * over the counter in cash does not — the money went back, and the invoice
 * still stands in full. Which of the two happened is decided by the refund mode,
 * and the document does not keep it: the only record is which account the
 * return credited. So this asks the ledger. It is also the reason the figure
 * cannot drift out of step with the control account — it *is* the control
 * account's movement.
 *
 * Exported because the allocation guard in `settlement-service` has to answer
 * the same question and must answer it the same way. Reporting what a document
 * owes and refusing to take more than it owes are one definition, and the two
 * going out of step is precisely how a receipt came to be accepted for more
 * than an invoice was owed. It takes a client so the guard can pass its
 * transaction and read the figure under the same lock as everything else.
 */
export async function settledByNotes(
  client: DbClient,
  params: {
    companyId: string;
    documentIds: readonly string[];
    side: "RECEIVABLE" | "PAYABLE";
  },
): Promise<Map<string, string>> {
  const empty = new Map<string, string>();
  if (params.documentIds.length === 0) return empty;

  const notes =
    params.side === "RECEIVABLE"
      ? await client.salesReturn.findMany({
          where: {
            companyId: params.companyId,
            saleId: { in: [...params.documentIds] },
            status: DocumentStatus.POSTED,
            journalEntryId: { not: null },
          },
          select: { saleId: true, journalEntryId: true },
        })
      : (
          await client.purchaseReturn.findMany({
            where: {
              companyId: params.companyId,
              purchaseId: { in: [...params.documentIds] },
              status: DocumentStatus.POSTED,
              journalEntryId: { not: null },
            },
            select: { purchaseId: true, journalEntryId: true },
          })
        ).map((note) => ({
          saleId: note.purchaseId,
          journalEntryId: note.journalEntryId,
        }));

  if (notes.length === 0) return empty;

  const control = await client.account.findFirst({
    where: {
      companyId: params.companyId,
      systemKey:
        params.side === "RECEIVABLE"
          ? SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE
          : SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
    },
    select: { id: true },
  });
  if (!control) return empty;

  const lines = await client.journalLine.findMany({
    where: {
      companyId: params.companyId,
      accountId: control.id,
      status: JournalStatus.POSTED,
      journalEntryId: {
        in: notes.flatMap((note) =>
          note.journalEntryId ? [note.journalEntryId] : [],
        ),
      },
    },
    select: { journalEntryId: true, debit: true, credit: true },
  });

  // A credit note credits the receivable; a debit note debits the payable.
  // Either way what is wanted is the amount the control account came down by.
  const byEntry = new Map<string, Decimal>();
  for (const line of lines) {
    const movement =
      params.side === "RECEIVABLE"
        ? subtract(line.credit, line.debit)
        : subtract(line.debit, line.credit);
    byEntry.set(
      line.journalEntryId,
      add(byEntry.get(line.journalEntryId) ?? money(0), movement),
    );
  }

  const byDocument = new Map<string, Decimal>();
  for (const note of notes) {
    if (!note.saleId || !note.journalEntryId) continue;
    const settled = byEntry.get(note.journalEntryId);
    if (!settled) continue;
    byDocument.set(
      note.saleId,
      add(byDocument.get(note.saleId) ?? money(0), settled),
    );
  }

  return new Map(
    [...byDocument].map(([id, amount]) => [id, toStorageString(amount)]),
  );
}

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

  const credited = await settledByNotes(client, {
    companyId: params.companyId,
    documentIds: sales.map((sale) => sale.id),
    side: "RECEIVABLE",
  });

  const now = new Date();
  return sales
    .map((sale) => {
      const due = sale.dueDate ?? sale.invoiceDate;
      const settled = add(sale.paidAmount, credited.get(sale.id) ?? money(0));
      const outstanding = subtract(sale.totalAmount, settled);
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

  const debited = await settledByNotes(client, {
    companyId: params.companyId,
    documentIds: purchases.map((purchase) => purchase.id),
    side: "PAYABLE",
  });

  const now = new Date();
  return purchases
    .map((purchase) => {
      const due = purchase.dueDate ?? purchase.billDate;
      const settled = add(
        purchase.paidAmount,
        debited.get(purchase.id) ?? money(0),
      );
      const outstanding = subtract(purchase.totalAmount, settled);
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

/**
 * What the control account holds that no document accounts for.
 *
 * The ageing is built from documents because documents are what carry a due
 * date. Not everything that lands on a receivable is a document. A customer
 * carried over from the old books arrives as an opening balance; money received
 * without being matched to an invoice sits as an advance; a bad debt written
 * back by hand is a journal entry and nothing else. None of those is a sale, so
 * none of them reached this report — and a shop that had just moved onto the
 * product, having entered every customer it was owed by, saw a receivables
 * total of nil while its receivable account held the lot.
 *
 * The README promises that a customer statement "reconciles with the ageing
 * report exactly, because both are derived from the same posted lines". They
 * were not the same lines: the statement reads the control account and this read
 * sale rows. So the difference between the two is computed here and carried into
 * the ageing as one more figure per party, which makes that promise true by
 * construction rather than by coincidence — including for whatever anybody posts
 * to a receivable in future that nobody has thought of yet.
 *
 * The residual is dated from the party's earliest posted line on the account,
 * which is when the balance was brought on. Carried-forward debt then ages from
 * the day it was entered rather than appearing as if it arose today.
 */
async function controlAccountByParty(
  companyId: string,
  side: "RECEIVABLE" | "PAYABLE",
): Promise<Map<string, { balance: Decimal; since: Date }>> {
  const empty = new Map<string, { balance: Decimal; since: Date }>();

  const account = await prisma.account.findFirst({
    where: {
      companyId,
      systemKey:
        side === "RECEIVABLE"
          ? SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE
          : SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
    },
    select: { id: true },
  });
  if (!account) return empty;

  const rows = await prisma.journalLine.groupBy({
    by: ["partyId"],
    where: {
      companyId,
      accountId: account.id,
      status: JournalStatus.POSTED,
      partyType:
        side === "RECEIVABLE" ? PartyType.CUSTOMER : PartyType.SUPPLIER,
      partyId: { not: null },
    },
    _sum: { debit: true, credit: true },
    _min: { entryDate: true },
  });

  for (const row of rows) {
    if (!row.partyId) continue;
    // A receivable is a debit balance and a payable a credit one; both are
    // wanted as "what is owed", so the sign is taken the right way round.
    const balance =
      side === "RECEIVABLE"
        ? subtract(row._sum.debit ?? 0, row._sum.credit ?? 0)
        : subtract(row._sum.credit ?? 0, row._sum.debit ?? 0);
    empty.set(row.partyId, {
      balance,
      since: row._min.entryDate ?? new Date(),
    });
  }

  return empty;
}

/**
 * Adds the part of each party's balance that no document explains.
 *
 * Positive where something was brought on outside a document — an opening
 * balance, a manual entry — and negative where money was taken without being
 * matched to one, which is an advance and genuinely reduces what is owed.
 */
async function withLedgerResidual(
  companyId: string,
  side: "RECEIVABLE" | "PAYABLE",
  documents: Array<{
    partyId: string;
    partyName: string;
    dueDate: Date;
    outstanding: Decimal;
  }>,
): Promise<typeof documents> {
  const control = await controlAccountByParty(companyId, side);
  if (control.size === 0) return documents;

  const documented = new Map<string, Decimal>();
  for (const document of documents) {
    documented.set(
      document.partyId,
      add(documented.get(document.partyId) ?? money(0), document.outstanding),
    );
  }

  const residuals: Array<{ partyId: string; balance: Decimal; since: Date }> =
    [];
  for (const [partyId, entry] of control) {
    const residual = subtract(
      entry.balance,
      documented.get(partyId) ?? money(0),
    );
    if (residual.isZero()) continue;
    residuals.push({ partyId, balance: residual, since: entry.since });
  }
  if (residuals.length === 0) return documents;

  // Names for parties the documents never mentioned — a customer carried over
  // and not yet invoiced has no sale to take a name from.
  const named = new Map(documents.map((d) => [d.partyId, d.partyName]));
  const missing = residuals
    .filter((entry) => !named.has(entry.partyId))
    .map((entry) => entry.partyId);
  if (missing.length > 0) {
    const parties =
      side === "RECEIVABLE"
        ? await prisma.customer.findMany({
            where: { companyId, id: { in: missing } },
            select: { id: true, name: true },
          })
        : await prisma.supplier.findMany({
            where: { companyId, id: { in: missing } },
            select: { id: true, name: true },
          });
    for (const party of parties) named.set(party.id, party.name);
  }

  // A residual above nil is a balance no document explains — carried over from
  // the old books, or written on by hand — so it joins the list as one more
  // thing owed, dated from when it was brought on.
  //
  // Below nil it is money taken without being matched to a document, and it has
  // to come *off this party's own debt* rather than join the list. `summarise`
  // drops a non-positive row deliberately, so that one customer's credit cannot
  // net away another's debt — right for documents, and the reason an advance
  // cannot simply be appended here. It is applied oldest first, which is what
  // the rest of this module means by settling: money goes against the debt that
  // has been waiting longest.
  const reduced = documents.map((document) => ({ ...document }));
  const rows: typeof documents = [];

  for (const entry of residuals) {
    if (entry.balance.greaterThan(0)) {
      rows.push({
        partyId: entry.partyId,
        partyName: named.get(entry.partyId) ?? "—",
        dueDate: entry.since,
        outstanding: entry.balance,
      });
      continue;
    }

    let advance = subtract(money(0), entry.balance);
    const theirs = reduced
      .filter((document) => document.partyId === entry.partyId)
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

    for (const document of theirs) {
      if (!advance.greaterThan(0)) break;
      const taken = document.outstanding.greaterThan(advance)
        ? advance
        : document.outstanding;
      document.outstanding = subtract(document.outstanding, taken);
      advance = subtract(advance, taken);
    }
    // Anything still left is a party in net credit. They owe nothing, and the
    // credit stays out of the total rather than reducing somebody else's debt.
  }

  return [...reduced, ...rows];
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
      id: true,
      customerId: true,
      invoiceDate: true,
      dueDate: true,
      totalAmount: true,
      paidAmount: true,
      customer: { select: { name: true } },
    },
  });

  const credited = await settledByNotes(prisma, {
    companyId,
    documentIds: sales.map((sale) => sale.id),
    side: "RECEIVABLE",
  });

  const now = new Date();
  const documents = await withLedgerResidual(
    companyId,
    "RECEIVABLE",
    sales
      .map((sale) => ({
        partyId: sale.customerId ?? "",
        partyName: sale.customer?.name ?? "—",
        dueDate: sale.dueDate ?? sale.invoiceDate,
        outstanding: subtract(
          sale.totalAmount,
          add(sale.paidAmount, credited.get(sale.id) ?? money(0)),
        ),
      }))
      .filter((document) => document.outstanding.greaterThan(0)),
  );

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
      id: true,
      supplierId: true,
      billDate: true,
      dueDate: true,
      totalAmount: true,
      paidAmount: true,
      supplier: { select: { name: true } },
    },
  });

  const debited = await settledByNotes(prisma, {
    companyId,
    documentIds: purchases.map((purchase) => purchase.id),
    side: "PAYABLE",
  });

  const now = new Date();
  const documents = await withLedgerResidual(
    companyId,
    "PAYABLE",
    purchases
      .map((purchase) => ({
        partyId: purchase.supplierId ?? "",
        partyName: purchase.supplier?.name ?? "—",
        dueDate: purchase.dueDate ?? purchase.billDate,
        outstanding: subtract(
          purchase.totalAmount,
          add(purchase.paidAmount, debited.get(purchase.id) ?? money(0)),
        ),
      }))
      .filter((document) => document.outstanding.greaterThan(0)),
  );

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
