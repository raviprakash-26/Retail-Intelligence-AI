import "server-only";
import { DocumentStatus, PaymentMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  add,
  compare,
  money,
  toStorageString,
  type Decimal,
} from "@/lib/money";
import { CASH_PAYMENT_LIMIT } from "@/lib/tax/presumptive";

/**
 * Cash paid to one person in one day, under section 40A(3).
 *
 * One rule, read by two callers who used to answer it differently. The income
 * tax working paper gathered from three places and keyed each payment by the
 * party it went to; the auditor wrote its own query over two of the three and
 * grouped by whatever name happened to be on the voucher. So a bill settled in
 * cash at the counter — the most ordinary way a shop pays a supplier, and the
 * example the auditor rule itself gives — was disallowed in the computation and
 * invisible to the check meant to warn about it before the year ended.
 *
 * It lives here so there is one answer. The aggregation takes an array and is
 * exercised directly; the gathering is the part that has to know where a cash
 * payment can hide.
 */

export type CashOutflow = {
  partyKey: string;
  partyName: string;
  date: Date;
  amount: Decimal;
  voucher: string;
  capital: boolean;
};

/** A day whose total to one person went over the limit. */
export type FlaggedPayment = {
  partyName: string;
  date: string;
  amount: string;
  /** The vouchers that made up the day's total. */
  vouchers: string[];
  capital: boolean;
};

export const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

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
export async function cashOutflows(params: {
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

/**
 * Days above the limit, aggregated the way section 40A(3) aggregates.
 *
 * The limit is on the total paid to one person in one day, not on any single
 * voucher — three payments of ₹4,000 to the same supplier on the same date are
 * caught, and splitting a payment to stay under the line is the specific thing
 * the aggregation exists to defeat. When a day is over the limit the *whole* of
 * it is disallowed, not the excess.
 */
export function aggregateCashDays(
  outflows: readonly CashOutflow[],
): FlaggedPayment[] {
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
