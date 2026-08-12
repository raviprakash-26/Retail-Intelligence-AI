import {
  compare,
  divide,
  money,
  subtract,
  toNumber,
  type MoneyInput,
} from "@/lib/money";

/**
 * The ratios a shopkeeper can act on.
 *
 * Every one of these is arithmetic on figures the books already contain. None
 * of it is AI, none of it is a projection, and none of it is advice — a ratio
 * is a fact about a period, and what to do about it is a conversation.
 *
 * The rule that shapes this whole module: **a ratio that cannot be computed
 * honestly is `null`, not zero.** A business with no closing stock has no
 * inventory turnover; printing "0 times" would say its stock never moves, which
 * is the opposite of the truth. Every null carries the reason with it, and the
 * interface prints the reason instead of a number.
 *
 * Where a figure crosses a line that is factual rather than a matter of
 * opinion — a current ratio under 1 *means* short-term debts exceed short-term
 * assets — that is flagged as a concern. Where the right level genuinely
 * depends on the trade, no verdict is offered, because inventing one would be
 * advice dressed up as arithmetic.
 */

export type RatioKey =
  | "grossMargin"
  | "netMargin"
  | "expenseRatio"
  | "inventoryTurnover"
  | "inventoryDays"
  | "receivableDays"
  | "payableDays"
  | "cashCycle"
  | "currentRatio"
  | "quickRatio"
  | "returnOnCapital";

export type RatioUnit = "percent" | "days" | "times" | "ratio";

export type Ratio = {
  key: RatioKey;
  label: string;
  /** Null where the figure cannot be computed from what the books contain. */
  value: number | null;
  unit: RatioUnit;
  /** What it means, in a sentence a shopkeeper would use. */
  meaning: string;
  /** Why there is no number, when there is none. */
  unavailable: string | null;
  /**
   * Something factually true about this figure that is worth knowing — not a
   * verdict on whether the business is run well.
   */
  concern: string | null;
};

export type RatioInputs = {
  /** Length of the window, in days. Drives everything expressed in days. */
  days: number;
  revenue: MoneyInput;
  costOfSales: MoneyInput;
  grossProfit: MoneyInput;
  operatingExpenses: MoneyInput;
  netProfit: MoneyInput;
  /** Goods bought in during the window, for the payable-days denominator. */
  purchases: MoneyInput;
  openingInventory: MoneyInput;
  closingInventory: MoneyInput;
  receivables: MoneyInput;
  payables: MoneyInput;
  currentAssets: MoneyInput;
  currentLiabilities: MoneyInput;
  /** Owner's capital plus what the business has earned and kept. */
  equity: MoneyInput;
};

/** A quotient, or null when the denominator cannot carry one. */
function ratioOf(
  numerator: MoneyInput,
  denominator: MoneyInput,
): number | null {
  const bottom = money(denominator);
  if (compare(bottom, 0) <= 0) return null;
  return round2(toNumber(divide(money(numerator), bottom)));
}

function percentOfBase(
  numerator: MoneyInput,
  denominator: MoneyInput,
): number | null {
  const value = ratioOf(numerator, denominator);
  return value === null ? null : round2(value * 100);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The average of the two ends of the window, which is what turnover wants. */
function averageInventory(inputs: RatioInputs): number {
  return (
    (toNumber(money(inputs.openingInventory)) +
      toNumber(money(inputs.closingInventory))) /
    2
  );
}

export function computeRatios(inputs: RatioInputs): Ratio[] {
  const days = Math.max(1, Math.round(inputs.days));
  const revenue = money(inputs.revenue);
  const hasRevenue = compare(revenue, 0) > 0;

  const grossMargin = percentOfBase(inputs.grossProfit, revenue);
  const netMargin = percentOfBase(inputs.netProfit, revenue);
  const expenseRatio = percentOfBase(inputs.operatingExpenses, revenue);

  const average = averageInventory(inputs);
  const inventoryTurnover =
    average > 0 ? ratioOf(inputs.costOfSales, average) : null;
  const inventoryDays =
    inventoryTurnover !== null && inventoryTurnover > 0
      ? round2(days / inventoryTurnover)
      : null;

  const receivableDays = hasRevenue
    ? round2((toNumber(money(inputs.receivables)) / toNumber(revenue)) * days)
    : null;

  const purchases = money(inputs.purchases);
  const payableDays =
    compare(purchases, 0) > 0
      ? round2((toNumber(money(inputs.payables)) / toNumber(purchases)) * days)
      : null;

  const cashCycle =
    inventoryDays !== null && receivableDays !== null && payableDays !== null
      ? round2(inventoryDays + receivableDays - payableDays)
      : null;

  const currentRatio = ratioOf(inputs.currentAssets, inputs.currentLiabilities);
  const quickRatio = ratioOf(
    subtract(inputs.currentAssets, inputs.closingInventory),
    inputs.currentLiabilities,
  );
  const returnOnCapital = percentOfBase(inputs.netProfit, inputs.equity);

  return [
    {
      key: "grossMargin",
      label: "Gross margin",
      value: grossMargin,
      unit: "percent",
      meaning:
        "What is left of every ₹100 of sales after paying for the goods, before any running cost.",
      unavailable: hasRevenue ? null : "Nothing was sold in this period.",
      concern:
        grossMargin !== null && grossMargin < 0
          ? "Goods are being sold for less than they cost. Every sale makes the loss larger."
          : null,
    },
    {
      key: "netMargin",
      label: "Net margin",
      value: netMargin,
      unit: "percent",
      meaning:
        "What is left of every ₹100 of sales once every cost is paid. This is the profit.",
      unavailable: hasRevenue ? null : "Nothing was sold in this period.",
      concern:
        netMargin !== null && netMargin < 0
          ? "The business made a loss over this period."
          : null,
    },
    {
      key: "expenseRatio",
      label: "Running costs",
      value: expenseRatio,
      unit: "percent",
      meaning:
        "Rent, salaries, power and everything else, as a share of sales. Gross margin has to cover this before there is any profit.",
      unavailable: hasRevenue ? null : "Nothing was sold in this period.",
      concern:
        expenseRatio !== null &&
        grossMargin !== null &&
        expenseRatio > grossMargin
          ? "Running costs are larger than the gross margin, so the shop cannot break even at this level of sales."
          : null,
    },
    {
      key: "inventoryTurnover",
      label: "Stock turnover",
      value: inventoryTurnover,
      unit: "times",
      meaning:
        "How many times the shelves were sold and refilled in this period. Faster means less money sitting still.",
      unavailable:
        average > 0
          ? null
          : "There was no stock at either end of the period, so there is nothing to turn over.",
      concern: null,
    },
    {
      key: "inventoryDays",
      label: "Days of stock",
      value: inventoryDays,
      unit: "days",
      meaning:
        "How long an item sits on the shelf, on average, before it is sold.",
      unavailable:
        inventoryDays === null
          ? "Stock turnover could not be computed, so neither can this."
          : null,
      concern: null,
    },
    {
      key: "receivableDays",
      label: "Collection days",
      value: receivableDays,
      unit: "days",
      meaning:
        "How long customers take to pay, on average. Money owed to you is money you cannot spend.",
      unavailable: hasRevenue ? null : "Nothing was sold in this period.",
      concern: null,
    },
    {
      key: "payableDays",
      label: "Payment days",
      value: payableDays,
      unit: "days",
      meaning: "How long you take to pay suppliers, on average.",
      unavailable:
        compare(purchases, 0) > 0
          ? null
          : "Nothing was bought in this period, so there is no basis to measure against.",
      concern: null,
    },
    {
      key: "cashCycle",
      label: "Cash cycle",
      value: cashCycle,
      unit: "days",
      meaning:
        "Days between paying for goods and being paid for them. A negative figure means customers pay before suppliers have to be.",
      unavailable:
        cashCycle === null
          ? "One of stock, collection or payment days could not be computed."
          : null,
      concern: null,
    },
    {
      key: "currentRatio",
      label: "Current ratio",
      value: currentRatio,
      unit: "ratio",
      meaning:
        "Short-term assets against short-term debts. It answers whether what is coming in covers what is going out.",
      unavailable:
        currentRatio === null ? "There are no short-term liabilities." : null,
      concern:
        currentRatio !== null && currentRatio < 1
          ? "Short-term debts are larger than short-term assets."
          : null,
    },
    {
      key: "quickRatio",
      label: "Quick ratio",
      value: quickRatio,
      unit: "ratio",
      meaning:
        "The same, but without counting stock — because stock has to be sold before it can pay anyone.",
      unavailable:
        quickRatio === null ? "There are no short-term liabilities." : null,
      concern:
        quickRatio !== null && quickRatio < 1
          ? "Without selling stock, short-term assets do not cover short-term debts."
          : null,
    },
    {
      key: "returnOnCapital",
      label: "Return on capital",
      value: returnOnCapital,
      unit: "percent",
      meaning: "What the money put into the business earned over this period.",
      unavailable:
        returnOnCapital === null
          ? "Capital in the business is nil or negative, so there is nothing to measure a return against."
          : null,
      concern: null,
    },
  ];
}

/** Formats a ratio for display, including the unit it is expressed in. */
export function formatRatio(ratio: Ratio): string {
  if (ratio.value === null) return "—";
  switch (ratio.unit) {
    case "percent":
      return `${ratio.value.toFixed(1)}%`;
    case "days":
      return `${Math.round(ratio.value)} days`;
    case "times":
      return `${ratio.value.toFixed(1)}×`;
    case "ratio":
      return ratio.value.toFixed(2);
  }
}

/**
 * Annualises a figure measured over a shorter window.
 *
 * Used only where a ratio is conventionally quoted for a year — stock turnover
 * of "2 times" means something different over a month than over a year, and a
 * figure whose period is not stated is a figure nobody can compare.
 */
export function annualise(value: number, days: number): number {
  if (days <= 0) return value;
  return round2((value * 365) / days);
}
