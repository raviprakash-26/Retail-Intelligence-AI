import type { PrismaClient } from "@prisma/client";
import { createExpense } from "@/server/expenses/expense-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import { createSale } from "@/server/sales/sale-service";
import {
  createPayment,
  createReceipt,
} from "@/server/settlements/settlement-service";
import { createSalesReturn } from "@/server/returns/sales-return-service";

/**
 * A demo shop that has actually traded.
 *
 * Until this existed the demo tenant was a fully stocked shop that had never
 * sold anything: seven products, four customers, an opening balance, and not a
 * single transaction. Every screen that matters was blank — the dashboard, the
 * analytics, the GST registers, the ageing, and every one of the AI modules,
 * which had nothing to read. Somebody opening the demo would reasonably
 * conclude the product did nothing.
 *
 * **Everything is posted through the ordinary services.** No fixture writes a
 * journal line, a stock movement or a tax entry directly. That is what makes
 * this data worth looking at: the books balance because the same engine balanced
 * them, the ageing is real because the invoices really are unpaid, and the GST
 * register agrees with the sales because it was built from them. A seed that
 * inserted rows directly would eventually disagree with the application in ways
 * a demo would show off.
 *
 * **Dates are relative to the run.** A demo seeded in April and opened in
 * September should not show a shop that stopped trading five months ago, so
 * everything is placed backwards from today.
 *
 * **It is deterministic.** The same seed produces the same figures, so a
 * browser test can assert against them rather than building its own history
 * first — which is what every test needing an invoice has had to do.
 */

/** Days back from today, so the demo never goes stale. */
const DAY = 86_400_000;

/** Days before the run on which the shop restocked. */
const RESTOCK_DAYS = [96, 82, 68, 54, 40, 26, 12];

/** How many days of selling the history covers. */
const TRADING_DAYS = 90;

/**
 * How far back the demo shop's history reaches.
 *
 * Exported because the company has to have been provisioned by then: a fiscal
 * calendar that starts after its own earliest invoice has nowhere to put it.
 * Seeded in, say, May, ninety-six days of history reach back over 1 April into
 * the previous fiscal year, and the seed failed outright — for roughly the
 * first three months of every year.
 */
export const DEMO_HISTORY_DAYS = Math.max(...RESTOCK_DAYS, TRADING_DAYS);

/**
 * The day the demo shop opened its books, given the day the seed runs.
 *
 * Provisioning starts a company's fiscal calendar on the day it is created, so
 * a demo provisioned today cannot hold an invoice from ninety-six days ago
 * once those ninety-six days cross 1 April. It opened before it started
 * trading, like any shop.
 */
export function demoOpenedOn(asOf: Date): Date {
  return new Date(asOf.getTime() - DEMO_HISTORY_DAYS * DAY);
}

const daysAgo = (days: number, from: Date) =>
  new Date(from.getTime() - days * DAY).toISOString().slice(0, 10);

/**
 * A pseudo-random sequence with a fixed seed.
 *
 * The variety is what makes the demo look like a shop rather than a pattern —
 * baskets of different sizes, some days busier than others. The fixed seed is
 * what lets a browser test assert a figure instead of building its own history
 * first. `Math.random` would give the first and lose the second.
 */
function sequence(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

export type TradingSummary = {
  purchases: number;
  sales: number;
  receipts: number;
  payments: number;
  expenses: number;
  returns: number;
};

export async function seedDemoTrading(
  prisma: PrismaClient,
  companyId: string,
  ownerId: string,
  asOf: Date,
): Promise<TradingSummary> {
  const actor = { companyId, userId: ownerId, actorEmail: "owner@demo" };

  const products = await prisma.product.findMany({
    where: { companyId },
    select: { id: true, sku: true, sellingPrice: true, purchasePrice: true },
    orderBy: { sku: "asc" },
  });
  const customers = await prisma.customer.findMany({
    where: { companyId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const suppliers = await prisma.supplier.findMany({
    where: { companyId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const categories = await prisma.expenseCategory.findMany({
    where: { companyId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const product = (index: number) => products[index % products.length]!;
  const customer = (index: number) => customers[index % customers.length]!;
  const supplier = (index: number) => suppliers[index % suppliers.length]!;

  const summary: TradingSummary = {
    purchases: 0,
    sales: 0,
    receipts: 0,
    payments: 0,
    expenses: 0,
    returns: 0,
  };

  // --- Stock in, first ------------------------------------------------------
  // Buying before selling, so the cost of what goes out is a cost the shop
  // actually incurred rather than an opening estimate. Quantities are generous
  // on purpose: a demo that runs a product into negative stock is showing a
  // bug that is not there.
  for (const [index, days] of RESTOCK_DAYS.entries()) {
    await createPurchase({
      ...actor,
      branchId: null,
      input: {
        supplierId: supplier(index).id,
        supplierBillNo: `BILL/${1000 + index}`,
        billDate: daysAgo(days, asOf),
        paymentMode: index % 3 === 0 ? "CREDIT" : "CASH",
        priceIncludesTax: false,
        claimInputCredit: true,
        notes: "",
        lines: products.slice(0, 4).map((_, line) => ({
          productId: products[(index + line) % products.length]!.id,
          description: "",
          quantity: 60 + line * 20,
          rate: Number(
            products[(index + line) % products.length]!.purchasePrice,
          ),
          discountPercent: 0,
        })),
      },
    });
    summary.purchases += 1;
  }

  // --- Trading --------------------------------------------------------------
  // Roughly ninety days of it. A kirana serves dozens of people a day, so a
  // demo with one sale a week reads as a shop nobody visits — and gives the
  // analytics, the forecasting and the GST register almost nothing to show.
  //
  // Counter sales settle as they are raised; the shops with credit terms do
  // not. That mix is what makes the ageing worth reading.
  const next = sequence(20_260_816);
  const posted: Array<{ id: string; customerId: string; days: number }> = [];

  for (let days = TRADING_DAYS; days >= 1; days -= 1) {
    // Two or three invoices most days, occasionally none — a closed day.
    const perDay = Math.floor(next() * 3) + (next() > 0.15 ? 1 : 0);

    for (let n = 0; n < perDay; n += 1) {
      // Walk-in Customer is the counter; the other three buy on credit.
      const onCredit = next() > 0.62;
      const who = onCredit ? Math.floor(next() * 3) : 3;

      const lineCount = next() > 0.7 ? 2 : 1;
      const lines = Array.from({ length: lineCount }, (_, line) => {
        const pick = product(Math.floor(next() * products.length) + line);
        return {
          productId: pick.id,
          description: "",
          quantity: Math.max(1, Math.floor(next() * 6) + 1),
          rate: Number(pick.sellingPrice),
          discountPercent: 0,
        };
      });

      // Two lines for the same product would be a data-entry mistake, not a
      // basket, and the form does not allow it either.
      const unique = lines.filter(
        (line, at) =>
          lines.findIndex((l) => l.productId === line.productId) === at,
      );

      const result = await createSale({
        ...actor,
        branchId: null,
        input: {
          customerId: customer(who).id,
          invoiceDate: daysAgo(days, asOf),
          paymentMode: onCredit ? "CREDIT" : "CASH",
          placeOfSupply: "",
          priceIncludesTax: false,
          notes: "",
          lines: unique,
        },
      });
      summary.sales += 1;
      if (onCredit) {
        posted.push({ id: result.id, customerId: customer(who).id, days });
      }
    }
  }

  // --- Money coming in ------------------------------------------------------
  // Most older credit invoices get settled and the recent ones do not, which
  // leaves a spread across the ageing buckets rather than one full column.
  // A few of the oldest are deliberately left unpaid: a demo where nothing is
  // ever seriously late cannot show what the product does about it.
  for (const invoice of posted) {
    const old = invoice.days > 20;
    const stubborn = invoice.days > 70 && next() > 0.45;
    if (!old || stubborn) continue;
    if (next() > 0.82) continue; // some simply have not paid yet

    const sale = await prisma.sale.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { totalAmount: true },
    });
    await createReceipt({
      ...actor,
      input: {
        kind: "CUSTOMER",
        partyId: invoice.customerId,
        date: daysAgo(Math.max(1, invoice.days - 18), asOf),
        paymentMode: next() > 0.5 ? "BANK" : "UPI",
        amount: Number(sale.totalAmount),
        referenceNo: "",
        notes: "",
        allocations: [
          { documentId: invoice.id, amount: Number(sale.totalAmount) },
        ],
      },
    });
    summary.receipts += 1;
  }

  // --- Money going out ------------------------------------------------------
  // Suppliers get paid too. Without this the payment voucher has nothing to
  // open, and a demo where money only ever comes in is not a shop.
  const creditBills = await prisma.purchase.findMany({
    where: { companyId, paymentMode: "CREDIT" },
    select: { id: true, supplierId: true, totalAmount: true, billDate: true },
    orderBy: { billDate: "asc" },
  });

  for (const bill of creditBills.slice(
    0,
    Math.max(1, creditBills.length - 1),
  )) {
    if (!bill.supplierId) continue;
    const age = Math.round((asOf.getTime() - bill.billDate.getTime()) / DAY);
    await createPayment({
      ...actor,
      input: {
        kind: "SUPPLIER",
        partyId: bill.supplierId,
        date: daysAgo(Math.max(1, age - 15), asOf),
        paymentMode: next() > 0.5 ? "BANK" : "CASH",
        amount: Number(bill.totalAmount),
        referenceNo: "",
        notes: "",
        allocations: [
          { documentId: bill.id, amount: Number(bill.totalAmount) },
        ],
      },
    });
    summary.payments += 1;
  }

  // --- Running the shop -----------------------------------------------------
  if (categories.length > 0) {
    const EXPENSES: Array<[days: number, amount: number, note: string]> = [
      [72, 18_000, "Shop rent"],
      [60, 2_400, "Electricity"],
      [42, 18_000, "Shop rent"],
      [30, 2_650, "Electricity"],
      [12, 18_000, "Shop rent"],
      [6, 1_200, "Packing material"],
    ];
    for (const [index, [days, amount, note]] of EXPENSES.entries()) {
      await createExpense({
        ...actor,
        branchId: null,
        input: {
          categoryId: categories[index % categories.length]!.id,
          expenseDate: daysAgo(days, asOf),
          paymentMode: "CASH",
          supplierId: "",
          payeeName: note,
          amount,
          taxPercent: 0,
          amountIncludesTax: false,
          claimInputCredit: false,
          isCapitalExpenditure: false,
          assetUsefulLifeMonths: 0,
          referenceNo: "",
          notes: note,
        },
      });
      summary.expenses += 1;
    }
  }

  // --- And one thing that went wrong ---------------------------------------
  // A demo with no returns shows a shop where nothing is ever damaged, which
  // is not a shop. It also gives the credit-note document something to open.
  const returnable = posted[posted.length - 1];
  if (returnable) {
    const lines = await prisma.saleItem.findMany({
      where: { saleId: returnable.id },
      select: { id: true },
      take: 1,
    });
    const line = lines[0];
    if (line) {
      await createSalesReturn({
        ...actor,
        branchId: null,
        input: {
          saleId: returnable.id,
          returnDate: daysAgo(Math.max(1, returnable.days - 3), asOf),
          reason: "One carton damaged in transit",
          refundMode: "CREDIT",
          lines: [{ sourceLineId: line.id, quantity: 1 }],
        },
      });
      summary.returns += 1;
    }
  }

  return summary;
}
