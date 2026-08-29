import "server-only";
import { GstDirection, JournalStatus, Prisma } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { applySetOff, type heads, type SetOffResult } from "@/lib/tax/set-off";
import {
  add,
  money,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";

/**
 * GST working papers.
 *
 * **Nothing here is a filing, and nothing here claims to be.** The platform
 * prepares a working paper from the transactions already recorded; a human
 * reviews it and files it on the GST portal. Every figure carries that framing
 * through to the interface, because a retailer who believes their return has
 * been filed when it has not is worse off than one with no software at all.
 *
 * Two things make the preparation worth having beyond the arithmetic.
 *
 * **The set-off order is applied properly.** IGST credit before CGST or SGST,
 * and no crossing between CGST and SGST. Getting it wrong produces a payable
 * that is arithmetically defensible and legally wrong.
 *
 * **The register is reconciled against the ledger.** GST is recorded twice — as
 * rows in the tax register and as balances in the GST accounts — by different
 * code. If the two disagree, the return is being prepared from figures the
 * books do not support, and that is exactly the sort of thing a notice is
 * issued about.
 */

export type RateSummary = {
  ratePercent: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  totalTax: string;
  documents: number;
};

export type PartySummary = {
  partyName: string;
  partyGstin: string | null;
  placeOfSupply: string | null;
  taxableValue: string;
  totalTax: string;
  documents: number;
};

export type HsnSummary = {
  hsnCode: string;
  taxableValue: string;
  totalTax: string;
  documents: number;
};

export type OutwardSupplies = {
  /** Sales to a customer with a GSTIN — the B2B table of GSTR-1. */
  b2b: PartySummary[];
  b2bTotal: RateSummary;
  /** Everything else, summarised by rate — the B2C table. */
  b2cByRate: RateSummary[];
  b2cTotal: RateSummary;
  byRate: RateSummary[];
  byHsn: HsnSummary[];
  total: RateSummary;
};

export type InwardSupplies = {
  byRate: RateSummary[];
  /** Credit the business is entitled to claim. */
  eligible: RateSummary;
  /** Tax paid that cannot be claimed — it stayed in the cost of the goods. */
  ineligible: RateSummary;
  bySupplier: PartySummary[];
};

export type GstReconciliation = {
  outputFromRegister: string;
  outputFromLedger: string;
  inputFromRegister: string;
  inputFromLedger: string;
  outputDifference: string;
  inputDifference: string;
  agrees: boolean;
};

export type GstWorkingPaper = {
  periodYear: number;
  periodMonth: number;
  label: string;
  from: string;
  to: string;
  outward: OutwardSupplies;
  inward: InwardSupplies;
  setOff: {
    liability: Record<string, string>;
    credit: Record<string, string>;
    steps: Array<{ from: string; against: string; amount: string }>;
    payable: Record<string, string>;
    carriedForward: Record<string, string>;
    totalPayable: string;
    totalCarriedForward: string;
  };
  reconciliation: GstReconciliation;
  /** Whether the business is registered under a scheme that files this at all. */
  registration: string;
  empty: boolean;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function periodLabel(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? month} ${year}`;
}

type RegisterRow = {
  direction: GstDirection;
  ratePercent: Decimal;
  taxableValue: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  totalTax: Decimal;
  partyName: string | null;
  partyGstin: string | null;
  placeOfSupply: string | null;
  hsnCode: string | null;
  itcEligible: boolean;
  documentId: string;
  isAmendment: boolean;
};

/**
 * Documents that were voided, and so belong on no table of the return.
 *
 * A void appends the document's own rows back with the sign flipped, under the
 * same document id — that is how the register stays append-only and a period
 * somebody has already read still shows what was there. The money nets to
 * nothing, which is right, and every table then counted the document anyway.
 *
 * So a return could carry a B2B line naming a customer, with a taxable value of
 * zero and one invoice against them: a supply that does not exist, reported to
 * a counterparty who would find it in their own GSTR-2B. The invoice count is
 * the figure an accountant reconciles against the portal, and it read one too
 * high for every invoice cancelled that month.
 *
 * A document is cancelled when its reversal sits beside it — original rows and
 * amendment rows sharing one id. Nothing else produces that. A credit note is a
 * document in its own right with its own id, so it is not caught here and still
 * appears, which is what the return requires of it.
 */
function cancelledDocuments(rows: readonly RegisterRow[]): ReadonlySet<string> {
  const original = new Set<string>();
  const reversed = new Set<string>();
  for (const row of rows) {
    (row.isAmendment ? reversed : original).add(row.documentId);
  }
  return new Set([...reversed].filter((id) => original.has(id)));
}

/** Adds a set of rows into one summary line. */
function summarise(
  rows: readonly RegisterRow[],
  ratePercent: string,
): RateSummary {
  return {
    ratePercent,
    taxableValue: toStorageString(add(...rows.map((row) => row.taxableValue))),
    cgst: toStorageString(add(...rows.map((row) => row.cgstAmount))),
    sgst: toStorageString(add(...rows.map((row) => row.sgstAmount))),
    igst: toStorageString(add(...rows.map((row) => row.igstAmount))),
    cess: toStorageString(add(...rows.map((row) => row.cessAmount))),
    totalTax: toStorageString(add(...rows.map((row) => row.totalTax))),
    // Distinct documents, not rows: one invoice with three rates is one
    // invoice, and a count of rows would overstate every table on the return.
    documents: new Set(rows.map((row) => row.documentId)).size,
  };
}

function groupByRate(rows: readonly RegisterRow[]): RateSummary[] {
  const groups = new Map<string, RegisterRow[]>();
  for (const row of rows) {
    const key = row.ratePercent.toFixed(2);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()]
    .map(([rate, group]) => summarise(group, rate))
    .sort((a, b) => Number(a.ratePercent) - Number(b.ratePercent));
}

function groupByParty(rows: readonly RegisterRow[]): PartySummary[] {
  const groups = new Map<string, RegisterRow[]>();
  for (const row of rows) {
    const key = `${row.partyGstin ?? ""}|${row.partyName ?? "—"}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.values()]
    .map((group) => ({
      partyName: group[0]?.partyName ?? "—",
      partyGstin: group[0]?.partyGstin ?? null,
      placeOfSupply: group[0]?.placeOfSupply ?? null,
      taxableValue: toStorageString(
        add(...group.map((row) => row.taxableValue)),
      ),
      totalTax: toStorageString(add(...group.map((row) => row.totalTax))),
      documents: new Set(group.map((row) => row.documentId)).size,
    }))
    .sort((a, b) => Number(b.taxableValue) - Number(a.taxableValue));
}

function groupByHsn(rows: readonly RegisterRow[]): HsnSummary[] {
  const groups = new Map<string, RegisterRow[]>();
  for (const row of rows) {
    const key = row.hsnCode ?? "—";
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()]
    .map(([hsnCode, group]) => ({
      hsnCode,
      taxableValue: toStorageString(
        add(...group.map((row) => row.taxableValue)),
      ),
      totalTax: toStorageString(add(...group.map((row) => row.totalTax))),
      documents: new Set(group.map((row) => row.documentId)).size,
    }))
    .sort((a, b) => Number(b.taxableValue) - Number(a.taxableValue));
}

/** Net balance on a GST account in the general ledger. */
async function ledgerTax(
  tx: DbClient,
  companyId: string,
  systemKeys: readonly string[],
  from: Date,
  to: Date,
): Promise<Decimal> {
  const accounts = await tx.account.findMany({
    where: { companyId, systemKey: { in: [...systemKeys] } },
    select: { id: true },
  });
  if (accounts.length === 0) return money(0);

  const totals = await tx.journalLine.aggregate({
    where: {
      companyId,
      accountId: { in: accounts.map((account) => account.id) },
      status: JournalStatus.POSTED,
      entryDate: { gte: from, lte: to },
    },
    _sum: { debit: true, credit: true },
  });

  // Output tax is a liability (credit) and input tax an asset (debit); the
  // caller knows which way round it wants, so this returns the raw net debit.
  return subtract(totals._sum.debit ?? 0, totals._sum.credit ?? 0);
}

/**
 * The register and the ledger for one month, read as one.
 *
 * The paper's whole purpose is to put the tax computed from the documents beside
 * the movement on the GST accounts and say whether they agree — written by
 * different code, compared with no tolerance, and reported at HIGH when they do
 * not. Reading them in separate statements let a sale land between the two, so
 * the document was in one figure and not the other and the paper accused the
 * books of a disagreement they never had. `reconcileStock` had the same shape
 * and the same fix: one snapshot, taken at the first statement.
 */
export async function getGstWorkingPaper(params: {
  companyId: string;
  year: number;
  month: number;
}): Promise<GstWorkingPaper> {
  return prisma.$transaction((tx) => workingPaperWithin(tx, params), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

async function workingPaperWithin(
  tx: DbClient,
  params: {
    companyId: string;
    year: number;
    month: number;
  },
): Promise<GstWorkingPaper> {
  const { companyId, year, month } = params;
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));

  const [rows, company] = await Promise.all([
    tx.gstTransaction.findMany({
      where: { companyId, periodYear: year, periodMonth: month },
      select: {
        direction: true,
        ratePercent: true,
        taxableValue: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
        totalTax: true,
        partyName: true,
        partyGstin: true,
        placeOfSupply: true,
        hsnCode: true,
        itcEligible: true,
        documentId: true,
        isAmendment: true,
      },
    }),
    tx.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { gstRegistration: true },
    }),
  ]);

  const all = rows as RegisterRow[];
  const cancelled = cancelledDocuments(all);
  const live = all.filter((row) => !cancelled.has(row.documentId));

  const outwardRows = live.filter(
    (row) => row.direction === GstDirection.OUTWARD,
  );
  const inwardRows = live.filter(
    (row) => row.direction === GstDirection.INWARD,
  );

  // A registered customer goes in the B2B table; everyone else is B2C.
  const b2bRows = outwardRows.filter((row) => Boolean(row.partyGstin));
  const b2cRows = outwardRows.filter((row) => !row.partyGstin);

  const outward: OutwardSupplies = {
    b2b: groupByParty(b2bRows),
    b2bTotal: summarise(b2bRows, "all"),
    b2cByRate: groupByRate(b2cRows),
    b2cTotal: summarise(b2cRows, "all"),
    byRate: groupByRate(outwardRows),
    byHsn: groupByHsn(outwardRows),
    total: summarise(outwardRows, "all"),
  };

  const eligibleRows = inwardRows.filter((row) => row.itcEligible);
  const ineligibleRows = inwardRows.filter((row) => !row.itcEligible);

  const inward: InwardSupplies = {
    byRate: groupByRate(inwardRows),
    eligible: summarise(eligibleRows, "all"),
    ineligible: summarise(ineligibleRows, "all"),
    bySupplier: groupByParty(inwardRows),
  };

  // Only credit actually claimable is set off. Tax on an ineligible purchase
  // was never an asset — it went into the cost of the goods.
  const result = applySetOff(
    {
      igst: outward.total.igst,
      cgst: outward.total.cgst,
      sgst: outward.total.sgst,
      cess: outward.total.cess,
    },
    {
      igst: inward.eligible.igst,
      cgst: inward.eligible.cgst,
      sgst: inward.eligible.sgst,
      cess: inward.eligible.cess,
    },
  );

  const [outputLedger, inputLedger] = await Promise.all([
    ledgerTax(
      tx,
      companyId,
      [
        SYSTEM_ACCOUNT.GST_OUTPUT_CGST,
        SYSTEM_ACCOUNT.GST_OUTPUT_SGST,
        SYSTEM_ACCOUNT.GST_OUTPUT_IGST,
        SYSTEM_ACCOUNT.GST_OUTPUT_CESS,
      ],
      from,
      to,
    ),
    ledgerTax(
      tx,
      companyId,
      [
        SYSTEM_ACCOUNT.GST_INPUT_CGST,
        SYSTEM_ACCOUNT.GST_INPUT_SGST,
        SYSTEM_ACCOUNT.GST_INPUT_IGST,
        SYSTEM_ACCOUNT.GST_INPUT_CESS,
      ],
      from,
      to,
    ),
  ]);

  // Output tax is a credit balance, so its net debit is negative; flip it to
  // compare like with like against the register.
  const outputFromLedger = outputLedger.negated();
  const outputDifference = subtract(
    money(outward.total.totalTax),
    outputFromLedger,
  );
  const inputDifference = subtract(
    money(inward.eligible.totalTax),
    inputLedger,
  );

  return {
    periodYear: year,
    periodMonth: month,
    label: periodLabel(year, month),
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    outward,
    inward,
    setOff: serialiseSetOff(result),
    reconciliation: {
      outputFromRegister: outward.total.totalTax,
      outputFromLedger: toStorageString(outputFromLedger),
      inputFromRegister: inward.eligible.totalTax,
      inputFromLedger: toStorageString(inputLedger),
      outputDifference: toStorageString(outputDifference),
      inputDifference: toStorageString(inputDifference),
      agrees: outputDifference.isZero() && inputDifference.isZero(),
    },
    registration: company.gstRegistration,
    // What is left to report, not what was ever recorded. A month whose only
    // invoice was cancelled has nothing to prepare, and saying so is better
    // than a full working paper of zeros.
    empty: live.length === 0,
  };
}

function serialiseSetOff(result: SetOffResult): GstWorkingPaper["setOff"] {
  const asRecord = (value: ReturnType<typeof heads>) => ({
    igst: toStorageString(value.igst),
    cgst: toStorageString(value.cgst),
    sgst: toStorageString(value.sgst),
    cess: toStorageString(value.cess),
  });

  return {
    liability: asRecord(result.liability),
    credit: asRecord(result.credit),
    steps: result.steps.map((step) => ({
      from: step.from,
      against: step.against,
      amount: toStorageString(step.amount),
    })),
    payable: asRecord(result.payable),
    carriedForward: asRecord(result.carriedForward),
    totalPayable: toStorageString(result.totalPayable),
    totalCarriedForward: toStorageString(result.totalCarriedForward),
  };
}

/** Months that have any GST activity, newest first, for the period picker. */
export async function gstPeriods(
  companyId: string,
): Promise<Array<{ year: number; month: number; label: string }>> {
  const rows = await prisma.gstTransaction.groupBy({
    by: ["periodYear", "periodMonth"],
    where: { companyId },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
  });

  return rows.map((row) => ({
    year: row.periodYear,
    month: row.periodMonth,
    label: periodLabel(row.periodYear, row.periodMonth),
  }));
}
