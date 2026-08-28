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
  type MoneyInput,
} from "@/lib/money";
import {
  daysOverdue,
  summariseAgeing,
  type AgeingSummary,
} from "@/lib/settlements/ageing";

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
 * How late a document is, counted the way the ageing report counts it.
 *
 * `daysOverdue` in `lib/settlements/ageing` truncates both dates to the day
 * before subtracting, and says why: an invoice due today is not one second
 * overdue at four in the afternoon. These two readers did the subtraction
 * themselves, on the raw instants, and rounded — so from midday UTC, which is
 * half past five in the evening here, every figure came out a day high. The
 * ageing report and the invoice list, looking at the same invoice, disagreed
 * for the second half of every working day.
 *
 * `asOf` is threaded in rather than read here so that one call ages every
 * document against a single instant, which is what `summariseAgeing` already
 * asks of its caller, and so a test can pin the hour that used to decide the
 * answer.
 */
function lateness(dueDate: Date, asOf: Date): number {
  return Math.max(0, daysOverdue(dueDate, asOf));
}

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
  params: { companyId: string; customerId: string; asOf?: Date },
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

  const now = params.asOf ?? new Date();
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
        daysOverdue: lateness(due, now),
      };
    })
    .filter((document) => Number(document.outstanding) > 0);
}

/** Bills not fully paid, oldest due first. */
export async function openBills(
  client: DbClient,
  params: { companyId: string; supplierId: string; asOf?: Date },
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

  const now = params.asOf ?? new Date();
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
        daysOverdue: lateness(due, now),
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
  options: {
    /** Narrow to one party, for a caller asking about one. */
    partyId?: string;
    /** Read inside an enclosing transaction. Defaults to the shared client. */
    client?: DbClient;
  } = {},
): Promise<Map<string, { balance: Decimal; since: Date }>> {
  const empty = new Map<string, { balance: Decimal; since: Date }>();
  const client = options.client ?? prisma;

  const account = await client.account.findFirst({
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

  const rows = await client.journalLine.groupBy({
    by: ["partyId"],
    where: {
      companyId,
      accountId: account.id,
      status: JournalStatus.POSTED,
      partyType:
        side === "RECEIVABLE" ? PartyType.CUSTOMER : PartyType.SUPPLIER,
      partyId: options.partyId ? options.partyId : { not: null },
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
 * What one party owes, as the ledger has it.
 *
 * The control account's balance for them, which is the whole answer rather than
 * a part of it: every invoice, every receipt whether or not it was allocated,
 * every credit note, and an opening balance carried in from the old books. The
 * ageing report is this figure split by due date — `withLedgerResidual` adds
 * the part no document accounts for precisely so the two agree — so a caller
 * that reads this and a caller that reads the ageing are quoting one number.
 *
 * Which matters here more than usual. The credit limit is the only place in
 * the product that *refuses* on the strength of what somebody owes, and a limit
 * enforced against a different figure from the one the ageing report, the
 * reminder and the customer statement all show is a refusal nobody can argue
 * with.
 *
 * Takes a client so the sale can ask inside its own transaction, after it has
 * taken the row lock on the invoice sequence — which is what stops two
 * concurrent invoices to the same customer both reading a balance under the
 * limit and both being allowed.
 */
export async function owedByParty(
  client: DbClient,
  params: {
    companyId: string;
    side: "RECEIVABLE" | "PAYABLE";
    partyId: string;
  },
): Promise<Decimal> {
  const balances = await controlAccountByParty(params.companyId, params.side, {
    partyId: params.partyId,
    client,
  });
  return balances.get(params.partyId)?.balance ?? money(0);
}

/**
 * Money held for one party that no open document accounts for.
 *
 * A customer who sends ₹100 against a ₹250 invoice without saying which one has
 * still paid ₹100. The receipt credits receivables whether or not anybody
 * allocated it, so the ledger already knows; what it cannot do is reduce a
 * particular invoice, because the customer did not name one.
 *
 * `withLedgerResidual` has always taken this off the ageing report. Anything
 * quoting a figure to the customer needs the same number, and reaching it
 * through the same control-account read is the point — the module already
 * warns that three places deciding separately what a document still owes is
 * three chances to decide differently, and a reminder is the place where
 * deciding differently is read by somebody who kept their own records.
 *
 * Returns what is held, never negative: a party who owes more than the ledger
 * shows is a residual of the other kind, and that one belongs on the ageing
 * report as a debt rather than here as a credit.
 */
export async function unappliedCredit(params: {
  companyId: string;
  side: "RECEIVABLE" | "PAYABLE";
  partyId: string;
  /** What the open documents between you add up to. */
  documented: MoneyInput;
}): Promise<Decimal> {
  const held = await unappliedCreditByParty({
    companyId: params.companyId,
    side: params.side,
    documented: new Map([[params.partyId, money(params.documented)]]),
  });
  return held.get(params.partyId) ?? money(0);
}

/**
 * The same question for many parties at once, in one read of the control
 * account.
 *
 * A party absent from `documented` is absent from the answer: both callers ask
 * about people they already have documents for, and a party carrying a credit
 * and no open document is not somebody either of them is about to quote a
 * figure to.
 */
export async function unappliedCreditByParty(params: {
  companyId: string;
  side: "RECEIVABLE" | "PAYABLE";
  documented: ReadonlyMap<string, Decimal>;
}): Promise<Map<string, Decimal>> {
  const held = new Map<string, Decimal>();
  if (params.documented.size === 0) return held;

  const control = await controlAccountByParty(params.companyId, params.side);
  for (const [partyId, documented] of params.documented) {
    const entry = control.get(partyId);
    if (!entry) continue;
    const residual = subtract(entry.balance, documented);
    if (residual.greaterThan(0)) continue;
    held.set(partyId, residual.negated());
  }
  return held;
}

/**
 * Takes each party's on-account credit off their own debts, oldest first.
 *
 * Oldest first is what the rest of the product means by settling: money goes
 * against the debt that has been waiting longest. Nothing crosses between
 * parties — one customer's credit can never reduce another's debt — and a
 * credit larger than the debts simply runs out, leaving them at nil rather
 * than negative.
 *
 * Shared because three readers now need it and they must agree: the ageing
 * report, the auditor's long-overdue check, and the cash projection. Each one
 * of them quotes a figure somebody acts on — chasing a customer, or deciding
 * whether next month's wages will clear.
 */
export function afterUnappliedCredit<
  T extends { partyId: string; dueDate: Date; outstanding: Decimal },
>(documents: readonly T[], held: ReadonlyMap<string, Decimal>): T[] {
  if (held.size === 0) return documents.map((document) => ({ ...document }));

  const remaining = new Map(held);
  return [...documents]
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
    .map((document) => {
      const credit = remaining.get(document.partyId);
      if (!credit || !credit.greaterThan(0)) return { ...document };

      const taken = document.outstanding.greaterThan(credit)
        ? credit
        : document.outstanding;
      remaining.set(document.partyId, subtract(credit, taken));
      return {
        ...document,
        outstanding: subtract(document.outstanding, taken),
      };
    });
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
  // cannot simply be appended here. Anything left over after their own debts
  // are cleared is a party in net credit: they owe nothing, and the remainder
  // stays out of the total rather than reducing somebody else's.
  const held = new Map<string, Decimal>();
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
    held.set(entry.partyId, entry.balance.negated());
  }

  return [...afterUnappliedCredit(documents, held), ...rows];
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
