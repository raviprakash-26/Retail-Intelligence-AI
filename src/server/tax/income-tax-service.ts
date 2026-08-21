import "server-only";
import {
  type BusinessType,
  DocumentStatus,
  JournalStatus,
  PaymentMode,
  VoucherType,
  type AccountSubType,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { signedBalance } from "@/lib/accounting/double-entry";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import {
  add,
  compare,
  divide,
  money,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";
import {
  advanceTaxDue,
  advanceTaxSchedule,
  assessmentYearFor,
  computeIncomeTax,
  rateTableFor,
  regimeApplies,
  REGIME_LABELS,
  type AdvanceTaxInstalment,
  type Assessee,
  type TaxComputation,
  type TaxRegime,
} from "@/lib/tax/income-tax";
import {
  auditApplicability,
  CASH_PAYMENT_LIMIT,
  presumptiveIncome,
  type AuditApplicability,
  type PresumptiveResult,
} from "@/lib/tax/presumptive";
import {
  computeDepreciation,
  type DepreciationSchedule,
} from "@/lib/tax/depreciation";
import {
  accountBalances,
  NATURAL_SIDE_FOR_TYPE,
  type AccountBalance,
} from "@/server/accounting/balances";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import { settledByNotes } from "@/server/settlements/outstanding";

/**
 * The income tax working paper.
 *
 * **Everything here is an estimate prepared for review.** Nothing is filed,
 * nothing is submitted, and the platform has no way to do either. That framing
 * is not modesty — an owner who believes their return has been computed and
 * settled, when what they have is a starting point for their accountant, is
 * worse off than one with no software at all.
 *
 * What makes it worth having is that it starts from the books rather than from
 * a guess. The book profit comes out of the same statements engine every other
 * report reads, so the computation cannot disagree with the profit and loss
 * account. From there it does the three things a person doing this by hand
 * usually gets wrong:
 *
 *   • **Book depreciation comes out and the Act's depreciation goes in.** They
 *     are different calculations on different rules and they are not meant to
 *     agree.
 *   • **Disallowances are found in the records, not assumed.** Cash paid to one
 *     person in one day above the section 40A(3) limit is a fact about the
 *     payments already recorded, and it is listed with the vouchers behind it.
 *   • **Judgement is left where it belongs.** The mechanical adjustments are
 *     applied; the ones that turn on facts the platform cannot see are shown as
 *     a second figure, so the answer is a range with both ends explained rather
 *     than a single number carrying more confidence than it has earned.
 */

// ---------------------------------------------------------------------------
// Serialised shapes — Decimals become strings on the way to the client
// ---------------------------------------------------------------------------

export type ComputationLine = {
  label: string;
  /** Positive adds to income, negative reduces it. */
  amount: string;
  /** Why this line is here, in words. */
  note: string | null;
  emphasis?: "total" | "subtotal";
};

export type SerialisedBand = {
  from: number;
  to: number | null;
  ratePercent: number;
  income: string;
  tax: string;
};

export type SerialisedTax = {
  totalIncome: string;
  bands: SerialisedBand[];
  flatRatePercent: number | null;
  taxOnIncome: string;
  rebate: string;
  rebateNote: string | null;
  taxAfterRebate: string;
  surchargeRatePercent: number;
  surcharge: string;
  marginalRelief: string;
  cessPercent: number;
  cess: string;
  totalTax: string;
  roundedTax: string;
  effectiveRatePercent: number | null;
};

export type RegimeOutcome = {
  regime: TaxRegime;
  label: string;
  /** On the computed income, with only the mechanical adjustments applied. */
  normal: SerialisedTax;
  /** On the same income with every flagged item disallowed. Null when none. */
  withDisallowances: SerialisedTax | null;
  /** On the section 44AD deemed income. Null where the scheme is unavailable. */
  presumptive: SerialisedTax | null;
};

export type FlaggedPayment = {
  partyName: string;
  date: string;
  amount: string;
  /** The vouchers that made up the day's total. */
  vouchers: string[];
  capital: boolean;
};

export type UnpaidBill = {
  supplierName: string;
  number: string;
  date: string;
  outstanding: string;
  daysAtYearEnd: number;
};

export type SerialisedBlock = {
  label: string;
  ratePercent: number;
  openingWdv: string;
  additionsFullRate: string;
  additionsHalfRate: string;
  disposals: string;
  depreciation: string;
  closingWdv: string;
  exhausted: boolean;
  assets: Array<{
    id: string;
    name: string;
    blockLabel: string;
    ratePercent: number;
    rateInferred: boolean;
    purchaseDate: string;
    purchaseCost: string;
    addedThisYear: boolean;
    halfRate: boolean;
    disposedThisYear: boolean;
  }>;
};

export type SerialisedDepreciation = {
  blocks: SerialisedBlock[];
  openingWdv: string;
  additions: string;
  disposals: string;
  depreciation: string;
  closingWdv: string;
  notes: string[];
};

export type CashMix = {
  receipts: string;
  cashReceipts: string;
  bankReceipts: string;
  cashReceiptSharePercent: number;
  payments: string;
  cashPayments: string;
  bankPayments: string;
  cashPaymentSharePercent: number;
};

export type TaxWorkingPaper = {
  fiscalYear: {
    id: string;
    label: string;
    from: string;
    to: string;
    /** Calendar year the financial year opens in. */
    startYear: number;
  };
  assessmentYear: string;
  /** False when no rate table exists for the year — nothing is computed then. */
  ratesKnown: boolean;
  /** True where those rates were carried forward rather than legislated. */
  ratesProvisional: boolean;
  basis: string | null;
  assessee: Assessee;
  businessType: BusinessType;
  /** True when the business may choose between the two regimes. */
  regimeChoice: boolean;

  turnover: string;
  bookNetProfit: string;
  bookDepreciation: string;
  otherIncomeInBooks: string;

  computation: ComputationLine[];
  /** Negative where the year made a loss; the figure is not floored at nil. */
  taxableIncome: string;
  loss: boolean;
  /** Taxable income if every flagged item is disallowed. */
  taxableIncomeWithDisallowances: string;

  flagged: {
    cashPayments: FlaggedPayment[];
    cashPaymentsTotal: string;
    cashCapitalPaymentsTotal: string;
    unpaidBills: UnpaidBill[];
    unpaidBillsTotal: string;
    total: string;
  };

  depreciation: SerialisedDepreciation;
  cashMix: CashMix;
  presumptive: {
    turnover: string;
    digitalSharePercent: number;
    digitalTurnover: string;
    cashTurnover: string;
    incomeAtFullRate: string;
    incomeAtSplitRate: string;
    eligible: boolean;
    reasons: string[];
    limitApplied: number;
  };
  audit: AuditApplicability;

  regimes: RegimeOutcome[];
  /** The instalments, on the lowest tax any regime produces. */
  advanceTax: Array<{
    dueDate: string;
    cumulativePercent: number;
    cumulativeAmount: string;
    instalmentAmount: string;
    elapsed: boolean;
  }>;
  advanceTaxRequired: boolean;
  advanceTaxBasis: string;

  empty: boolean;
};

// ---------------------------------------------------------------------------
// Mapping the business to an assessee
// ---------------------------------------------------------------------------

/**
 * How a company's legal form is taxed.
 *
 * A sole proprietor is not a separate person for income tax: the business
 * income is the proprietor's own, taxed at their slab rates, and merged with
 * whatever else they earn. That last part is why every figure here is an
 * estimate — the platform sees the shop and not the person.
 */
const ASSESSEE_FOR_BUSINESS: Record<BusinessType, Assessee> = {
  SOLE_PROPRIETORSHIP: "INDIVIDUAL",
  HUF: "HUF",
  PARTNERSHIP: "FIRM",
  LLP: "LLP",
  PRIVATE_LIMITED: "COMPANY",
  PUBLIC_LIMITED: "COMPANY",
  OTHER: "INDIVIDUAL",
};

// ---------------------------------------------------------------------------
// Reading the books
// ---------------------------------------------------------------------------

/** Movement in the window, in the direction of the account type's own nature. */
function periodAmount(balance: AccountBalance): Decimal {
  return signedBalance(
    NATURAL_SIDE_FOR_TYPE[balance.type],
    balance.periodDebit,
    balance.periodCredit,
  );
}

function sumSubType(
  balances: readonly AccountBalance[],
  subType: AccountSubType,
): Decimal {
  return add(
    ...balances
      .filter((balance) => balance.subType === subType)
      .map(periodAmount),
  );
}

/**
 * Cash in and out, against everything else in and out.
 *
 * Read from the ledger rather than from the documents. Both section 44AD and
 * section 44AB turn on the share of money that moved in cash, and a document
 * carries a payment mode that may have been superseded by a later settlement —
 * the movement on the cash and bank accounts cannot be superseded by anything.
 *
 * Opening and closing entries are excluded. An opening balance is a position
 * carried into the year, not money received during it, and counting it would
 * make a shop that started the year with cash in the drawer look like a shop
 * that took cash over the counter. That distinction decides whether the
 * presumptive ceiling is ₹2 crore or ₹3 crore, so it is not a rounding matter.
 */
async function cashMix(params: {
  companyId: string;
  from: Date;
  to: Date;
  balances: readonly AccountBalance[];
}): Promise<CashMix> {
  const cashIds = new Set(
    params.balances
      .filter((balance) => balance.systemKey === SYSTEM_ACCOUNT.CASH)
      .map((balance) => balance.id),
  );
  const bankIds = new Set(
    params.balances
      .filter(
        (balance) =>
          balance.subType === "CASH_AND_BANK" &&
          balance.systemKey !== SYSTEM_ACCOUNT.CASH,
      )
      .map((balance) => balance.id),
  );

  const grouped = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: {
      companyId: params.companyId,
      status: JournalStatus.POSTED,
      entryDate: { gte: params.from, lte: params.to },
      accountId: { in: [...cashIds, ...bankIds] },
      journalEntry: {
        voucherType: {
          notIn: [VoucherType.OPENING_BALANCE, VoucherType.CLOSING_ENTRY],
        },
      },
    },
    _sum: { debit: true, credit: true },
  });

  let cashReceipts = money(0);
  let bankReceipts = money(0);
  let cashPayments = money(0);
  let bankPayments = money(0);

  for (const row of grouped) {
    const debit = money(row._sum.debit ?? 0);
    const credit = money(row._sum.credit ?? 0);
    if (cashIds.has(row.accountId)) {
      cashReceipts = add(cashReceipts, debit);
      cashPayments = add(cashPayments, credit);
    } else {
      bankReceipts = add(bankReceipts, debit);
      bankPayments = add(bankPayments, credit);
    }
  }

  const receipts = add(cashReceipts, bankReceipts);
  const payments = add(cashPayments, bankPayments);

  const share = (part: Decimal, whole: Decimal): number =>
    compare(whole, 0) > 0
      ? divide(part, whole).times(100).toDecimalPlaces(2).toNumber()
      : 0;

  return {
    receipts: toStorageString(receipts),
    cashReceipts: toStorageString(cashReceipts),
    bankReceipts: toStorageString(bankReceipts),
    cashReceiptSharePercent: share(cashReceipts, receipts),
    payments: toStorageString(payments),
    cashPayments: toStorageString(cashPayments),
    bankPayments: toStorageString(bankPayments),
    cashPaymentSharePercent: share(cashPayments, payments),
  };
}

type CashOutflow = {
  partyKey: string;
  partyName: string;
  date: Date;
  amount: Decimal;
  voucher: string;
  capital: boolean;
};

/**
 * Every rupee that left in cash, by whom it was received and on what day.
 *
 * Three places record one: an expense settled in cash, a bill paid in cash at
 * the counter, and a payment voucher against a credit bill. A bill settled at
 * the counter has no payment voucher — the amount sits on the bill itself — so
 * reading both sources adds nothing twice.
 *
 * Drawings are excluded. Money the owner takes out of the business is not
 * expenditure, so section 40A(3) has nothing to say about it however it moved.
 */
async function cashOutflows(params: {
  companyId: string;
  from: Date;
  to: Date;
}): Promise<CashOutflow[]> {
  const window = { gte: params.from, lte: params.to };

  const [expenses, purchases, payments] = await Promise.all([
    prisma.expense.findMany({
      where: {
        companyId: params.companyId,
        status: DocumentStatus.POSTED,
        paymentMode: PaymentMode.CASH,
        expenseDate: window,
      },
      select: {
        id: true,
        voucherNumber: true,
        expenseDate: true,
        totalAmount: true,
        payeeName: true,
        partyId: true,
        isCapitalExpenditure: true,
      },
    }),
    prisma.purchase.findMany({
      where: {
        companyId: params.companyId,
        status: DocumentStatus.POSTED,
        paymentMode: PaymentMode.CASH,
        billDate: window,
      },
      select: {
        id: true,
        billNumber: true,
        billDate: true,
        totalAmount: true,
        supplierId: true,
        supplier: { select: { name: true } },
      },
    }),
    prisma.payment.findMany({
      where: {
        companyId: params.companyId,
        status: DocumentStatus.POSTED,
        paymentMode: PaymentMode.CASH,
        paymentDate: window,
        purpose: { not: "DRAWINGS" },
      },
      select: {
        id: true,
        voucherNumber: true,
        paymentDate: true,
        amount: true,
        supplierId: true,
        purpose: true,
        supplier: { select: { name: true } },
      },
    }),
  ]);

  const outflows: CashOutflow[] = [];

  for (const expense of expenses) {
    const name = expense.payeeName?.trim() || "Unnamed payee";
    outflows.push({
      partyKey: expense.partyId ?? `name:${name.toLowerCase()}`,
      partyName: name,
      date: expense.expenseDate,
      amount: money(expense.totalAmount),
      voucher: expense.voucherNumber,
      capital: expense.isCapitalExpenditure,
    });
  }

  for (const purchase of purchases) {
    const name = purchase.supplier?.name ?? "Unnamed supplier";
    outflows.push({
      partyKey: purchase.supplierId ?? `name:${name.toLowerCase()}`,
      partyName: name,
      date: purchase.billDate,
      amount: money(purchase.totalAmount),
      voucher: purchase.billNumber,
      capital: false,
    });
  }

  for (const payment of payments) {
    const name = payment.supplier?.name ?? payment.purpose;
    outflows.push({
      partyKey: payment.supplierId ?? `purpose:${payment.purpose}`,
      partyName: name,
      date: payment.paymentDate,
      amount: money(payment.amount),
      voucher: payment.voucherNumber,
      capital: false,
    });
  }

  return outflows;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Days above the limit, aggregated the way section 40A(3) aggregates.
 *
 * The limit is on the total paid to one person in one day, not on any single
 * voucher — three payments of ₹4,000 to the same supplier on the same date are
 * caught, and splitting a payment to stay under the line is the specific thing
 * the aggregation exists to defeat. When a day is over the limit the *whole* of
 * it is disallowed, not the excess.
 */
function aggregateCashDays(outflows: readonly CashOutflow[]): FlaggedPayment[] {
  const days = new Map<
    string,
    {
      partyName: string;
      date: string;
      amount: Decimal;
      vouchers: string[];
      capital: boolean;
    }
  >();

  for (const outflow of outflows) {
    // Capital and revenue are kept apart: they are caught by different
    // provisions with different consequences, so pooling them would produce a
    // day that is over the limit for neither reason.
    const key = `${outflow.partyKey}|${isoDay(outflow.date)}|${outflow.capital}`;
    const existing = days.get(key);
    if (existing) {
      existing.amount = add(existing.amount, outflow.amount);
      existing.vouchers.push(outflow.voucher);
    } else {
      days.set(key, {
        partyName: outflow.partyName,
        date: isoDay(outflow.date),
        amount: outflow.amount,
        vouchers: [outflow.voucher],
        capital: outflow.capital,
      });
    }
  }

  return [...days.values()]
    .filter((day) => compare(day.amount, CASH_PAYMENT_LIMIT) > 0)
    .sort((a, b) => compare(b.amount, a.amount) || a.date.localeCompare(b.date))
    .map((day) => ({
      partyName: day.partyName,
      date: day.date,
      amount: toStorageString(day.amount),
      vouchers: day.vouchers.sort(),
      capital: day.capital,
    }));
}

/**
 * Supplier bills from the year that are still unpaid.
 *
 * Section 43B(h) disallows the cost of goods bought from a registered micro or
 * small enterprise until it is actually paid, where payment ran past the time
 * limit. The platform does not know which suppliers are registered as such —
 * that is on the invoice or on the Udyam portal — so this is exposure to check,
 * not a disallowance to apply.
 *
 * It lists bills still outstanding today. A bill that was unpaid at the year
 * end and settled since is caught by the section just the same, so this is a
 * floor rather than the whole of it, and the interface says so.
 */
async function unpaidBills(params: {
  companyId: string;
  to: Date;
  /** Bills younger than this at the year end are not yet in question. */
  ageDays: number;
}): Promise<UnpaidBill[]> {
  const purchases = await prisma.purchase.findMany({
    where: {
      companyId: params.companyId,
      status: DocumentStatus.POSTED,
      billDate: { lte: params.to },
    },
    select: {
      id: true,
      billNumber: true,
      billDate: true,
      totalAmount: true,
      paidAmount: true,
      supplier: { select: { name: true } },
    },
    orderBy: { billDate: "asc" },
  });

  // Goods sent back are not a debt left unpaid.
  //
  // This read the bill as its total less what had been paid, which counts a
  // debit note as money still owed. A bill returned in full and never paid
  // therefore appeared here in full — and what appears here is disallowed
  // expenditure, so the working paper raised taxable income by the value of
  // goods the shop had sent back and did not owe a rupee for.
  //
  // `settledByNotes` is the same function the ageing report, the allocation cap
  // and the cash projection use. This was the fourth place deciding on its own
  // what a document still owes, and the only one where deciding wrongly costs
  // the shop tax rather than a wrong figure on a screen.
  const debited = await settledByNotes(prisma, {
    companyId: params.companyId,
    documentIds: purchases.map((purchase) => purchase.id),
    side: "PAYABLE",
  });

  const rows: UnpaidBill[] = [];
  for (const purchase of purchases) {
    const outstanding = subtract(
      purchase.totalAmount,
      add(purchase.paidAmount, debited.get(purchase.id) ?? money(0)),
    );
    if (compare(outstanding, 0) <= 0) continue;

    const days = Math.floor(
      (params.to.getTime() - purchase.billDate.getTime()) / 86_400_000,
    );
    if (days <= params.ageDays) continue;

    rows.push({
      supplierName: purchase.supplier?.name ?? "Unnamed supplier",
      number: purchase.billNumber,
      date: isoDay(purchase.billDate),
      outstanding: toStorageString(outstanding),
      daysAtYearEnd: days,
    });
  }

  return rows.sort((a, b) => Number(b.outstanding) - Number(a.outstanding));
}

/** The section 43B(h) time limit where there is no written agreement. */
const MSE_PAYMENT_DAYS = 45;

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

function serialiseTax(computation: TaxComputation): SerialisedTax {
  return {
    totalIncome: toStorageString(computation.totalIncome),
    bands: computation.bands.map((band) => ({
      from: band.from,
      to: band.to,
      ratePercent: band.ratePercent,
      income: toStorageString(band.income),
      tax: toStorageString(band.tax),
    })),
    flatRatePercent: computation.flatRatePercent,
    taxOnIncome: toStorageString(computation.taxOnIncome),
    rebate: toStorageString(computation.rebate),
    rebateNote: computation.rebateNote,
    taxAfterRebate: toStorageString(computation.taxAfterRebate),
    surchargeRatePercent: computation.surchargeRatePercent,
    surcharge: toStorageString(computation.surcharge),
    marginalRelief: toStorageString(computation.marginalRelief),
    cessPercent: computation.cessPercent,
    cess: toStorageString(computation.cess),
    totalTax: toStorageString(computation.totalTax),
    roundedTax: toStorageString(computation.roundedTax),
    effectiveRatePercent: computation.effectiveRatePercent,
  };
}

function serialiseDepreciation(
  schedule: DepreciationSchedule,
): SerialisedDepreciation {
  return {
    blocks: schedule.blocks.map((block) => ({
      label: block.label,
      ratePercent: block.ratePercent,
      openingWdv: toStorageString(block.openingWdv),
      additionsFullRate: toStorageString(block.additionsFullRate),
      additionsHalfRate: toStorageString(block.additionsHalfRate),
      disposals: toStorageString(block.disposals),
      depreciation: toStorageString(block.depreciation),
      closingWdv: toStorageString(block.closingWdv),
      exhausted: block.exhausted,
      assets: block.assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        blockLabel: asset.blockLabel,
        ratePercent: asset.ratePercent,
        rateInferred: asset.rateInferred,
        purchaseDate: asset.purchaseDate,
        purchaseCost: toStorageString(asset.purchaseCost),
        addedThisYear: asset.addedThisYear,
        halfRate: asset.halfRate,
        disposedThisYear: asset.disposedThisYear,
      })),
    })),
    openingWdv: toStorageString(schedule.openingWdv),
    additions: toStorageString(schedule.additions),
    disposals: toStorageString(schedule.disposals),
    depreciation: toStorageString(schedule.depreciation),
    closingWdv: toStorageString(schedule.closingWdv),
    notes: schedule.notes,
  };
}

function serialisePresumptive(
  result: PresumptiveResult,
): TaxWorkingPaper["presumptive"] {
  return {
    turnover: toStorageString(result.turnover),
    digitalSharePercent: result.digitalSharePercent,
    digitalTurnover: toStorageString(result.digitalTurnover),
    cashTurnover: toStorageString(result.cashTurnover),
    incomeAtFullRate: toStorageString(result.incomeAtFullRate),
    incomeAtSplitRate: toStorageString(result.incomeAtSplitRate),
    eligible: result.eligible,
    reasons: result.reasons,
    limitApplied: result.limitApplied,
  };
}

function serialiseInstalments(
  instalments: readonly AdvanceTaxInstalment[],
): TaxWorkingPaper["advanceTax"] {
  return instalments.map((instalment) => ({
    dueDate: instalment.dueDate,
    cumulativePercent: instalment.cumulativePercent,
    cumulativeAmount: toStorageString(instalment.cumulativeAmount),
    instalmentAmount: toStorageString(instalment.instalmentAmount),
    elapsed: instalment.elapsed,
  }));
}

// ---------------------------------------------------------------------------
// The working paper
// ---------------------------------------------------------------------------

export async function getTaxWorkingPaper(params: {
  companyId: string;
  fiscalYearId: string;
  asOf?: Date;
}): Promise<TaxWorkingPaper | null> {
  const year = await prisma.fiscalYear.findFirst({
    where: { id: params.fiscalYearId, companyId: params.companyId },
    select: { id: true, label: true, startDate: true, endDate: true },
  });
  if (!year) return null;

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: params.companyId },
    select: { businessType: true },
  });

  const from = year.startDate;
  const to = year.endDate;
  const assessee = ASSESSEE_FOR_BUSINESS[company.businessType];
  const startYear = from.getUTCFullYear();
  const assessmentYear = assessmentYearFor(startYear);
  const table = rateTableFor(assessmentYear);

  const [statements, balances, assets, outflows, bills] = await Promise.all([
    getFinancialStatements({
      companyId: params.companyId,
      from: isoDay(from),
      to: isoDay(to),
    }),
    accountBalances({ companyId: params.companyId, from, to }),
    prisma.fixedAsset.findMany({
      where: { companyId: params.companyId, purchaseDate: { lte: to } },
      select: {
        id: true,
        name: true,
        category: true,
        purchaseDate: true,
        purchaseCost: true,
        ratePercent: true,
        disposedAt: true,
        disposalValue: true,
      },
      orderBy: { purchaseDate: "asc" },
    }),
    cashOutflows({ companyId: params.companyId, from, to }),
    unpaidBills({
      companyId: params.companyId,
      to,
      ageDays: MSE_PAYMENT_DAYS,
    }),
  ]);

  // Turnover is revenue net of returns, straight out of the trading account.
  // Taking it from anywhere else would eventually disagree with the statements.
  const turnover = money(statements.trading.revenueTotal);
  const bookNetProfit = money(statements.profitAndLoss.netProfit);
  const bookDepreciation = sumSubType(balances, "DEPRECIATION");
  const otherIncomeInBooks = sumSubType(balances, "OTHER_INCOME");

  const depreciation = computeDepreciation({
    assets: assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      category: asset.category,
      purchaseDate: asset.purchaseDate,
      purchaseCost: asset.purchaseCost,
      ratePercent: asset.ratePercent,
      disposedAt: asset.disposedAt,
      disposalValue: asset.disposalValue,
    })),
    from,
    to,
  });

  const mix = await cashMix({
    companyId: params.companyId,
    from,
    to,
    balances,
  });

  const cashDays = aggregateCashDays(outflows);
  const revenueCashDays = cashDays.filter((day) => !day.capital);
  const capitalCashDays = cashDays.filter((day) => day.capital);
  const cashPaymentsTotal = add(...revenueCashDays.map((day) => day.amount));
  const cashCapitalPaymentsTotal = add(
    ...capitalCashDays.map((day) => day.amount),
  );
  const unpaidBillsTotal = add(...bills.map((bill) => bill.outstanding));
  const flaggedTotal = add(cashPaymentsTotal, unpaidBillsTotal);

  // The mechanical adjustments: book depreciation out, the Act's in.
  //
  // Not clamped at zero. A year that made a loss has to say so — the
  // computation is a statement that has to add up, and a figure quietly floored
  // at nil turns three lines that should reconcile into three that do not. Tax
  // on a loss is nothing, which the tax computation itself takes care of.
  const taxableIncome = add(
    bookNetProfit,
    bookDepreciation,
    subtract(0, depreciation.depreciation),
  );
  const taxableIncomeWithDisallowances = add(taxableIncome, flaggedTotal);
  const loss = compare(taxableIncome, 0) < 0;

  const computation: ComputationLine[] = [
    {
      label: "Net profit as per the profit and loss account",
      amount: toStorageString(bookNetProfit),
      note: "The same figure the statements show for this year. Nothing has been recomputed.",
    },
    {
      label: "Add: depreciation charged in the books",
      amount: toStorageString(bookDepreciation),
      note: "Book depreciation is not allowed as such. It comes back and the Act's own figure goes in below.",
    },
    {
      label: "Less: depreciation under the Income-tax Act",
      amount: toStorageString(subtract(0, depreciation.depreciation)),
      note: "Written down value method on blocks of assets, at the rates in Appendix I to the Rules.",
    },
    {
      label: loss
        ? "Estimated loss from business"
        : "Estimated income from business",
      amount: toStorageString(taxableIncome),
      note: loss
        ? "A loss is not negative tax. It is carried forward and set against business income in later years, which this working paper does not track."
        : null,
      emphasis: "total",
    },
  ];

  const presumptive = presumptiveIncome({
    turnover,
    digitalReceipts: mix.bankReceipts,
    cashReceipts: mix.cashReceipts,
    assessee,
  });

  const audit = auditApplicability({
    turnover,
    cashReceiptSharePercent: mix.cashReceiptSharePercent,
    cashPaymentSharePercent: mix.cashPaymentSharePercent,
  });

  const regimes: RegimeOutcome[] = [];
  if (table) {
    const choices: TaxRegime[] = regimeApplies(assessee)
      ? ["NEW", "OLD"]
      : ["NEW"];

    for (const regime of choices) {
      const at = (income: Decimal) =>
        serialiseTax(
          computeIncomeTax({ totalIncome: income, table, assessee, regime }),
        );

      regimes.push({
        regime,
        label: REGIME_LABELS[regime],
        normal: at(taxableIncome),
        withDisallowances:
          compare(flaggedTotal, 0) > 0
            ? at(taxableIncomeWithDisallowances)
            : null,
        presumptive: presumptive.eligible
          ? at(money(presumptive.incomeAtSplitRate))
          : null,
      });
    }

    // Cheapest first. This is arithmetic, not a recommendation — the two are
    // shown side by side and the reason one is lower is on the page.
    regimes.sort(
      (a, b) => Number(a.normal.totalTax) - Number(b.normal.totalTax),
    );
  }

  const lowest = regimes[0];
  const advanceTaxBase = lowest ? money(lowest.normal.totalTax) : money(0);

  const empty =
    compare(turnover, 0) === 0 &&
    compare(bookNetProfit, 0) === 0 &&
    depreciation.blocks.length === 0;

  return {
    fiscalYear: {
      id: year.id,
      label: year.label,
      from: isoDay(from),
      to: isoDay(to),
      startYear,
    },
    assessmentYear,
    ratesKnown: table !== null,
    ratesProvisional: table?.provisional ?? false,
    basis: table?.basis ?? null,
    assessee,
    businessType: company.businessType,
    regimeChoice: regimeApplies(assessee),

    turnover: toStorageString(turnover),
    bookNetProfit: toStorageString(bookNetProfit),
    bookDepreciation: toStorageString(bookDepreciation),
    otherIncomeInBooks: toStorageString(otherIncomeInBooks),

    computation,
    taxableIncome: toStorageString(taxableIncome),
    loss,
    taxableIncomeWithDisallowances: toStorageString(
      taxableIncomeWithDisallowances,
    ),

    flagged: {
      cashPayments: revenueCashDays,
      cashPaymentsTotal: toStorageString(cashPaymentsTotal),
      cashCapitalPaymentsTotal: toStorageString(cashCapitalPaymentsTotal),
      unpaidBills: bills,
      unpaidBillsTotal: toStorageString(unpaidBillsTotal),
      total: toStorageString(flaggedTotal),
    },

    depreciation: serialiseDepreciation(depreciation),
    cashMix: mix,
    presumptive: serialisePresumptive(presumptive),
    audit,

    regimes,
    advanceTax: serialiseInstalments(
      advanceTaxSchedule({
        totalTax: advanceTaxBase,
        financialYearStart: startYear,
        asOf: params.asOf,
      }),
    ),
    advanceTaxRequired: advanceTaxDue(advanceTaxBase),
    advanceTaxBasis: lowest
      ? loss
        ? "The year is in loss, so there is nothing to pay in advance on this year's business income."
        : `On the estimated income of ${toStorageString(taxableIncome)} under the ${lowest.label.toLowerCase()}, before any disallowance.`
      : "No rate table is available for this assessment year, so no schedule has been worked out.",

    empty,
  };
}
