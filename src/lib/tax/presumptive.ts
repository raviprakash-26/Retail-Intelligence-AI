import {
  add,
  compare,
  divide,
  max,
  money,
  percentOf,
  subtract,
  type Decimal,
  type MoneyInput,
} from "@/lib/money";
import type { Assessee } from "@/lib/tax/income-tax";

/**
 * Presumptive taxation of business income — section 44AD.
 *
 * A small business may declare a fixed percentage of its turnover as profit
 * instead of computing income from its accounts. For a retailer whose real
 * margin is thin this is often worse than the ordinary computation and for one
 * whose margin is healthy it is often better, which is exactly why the two
 * belong side by side rather than one being chosen for them.
 *
 * The rules that matter here:
 *
 *   • Only a resident individual, Hindu Undivided Family or partnership firm
 *     may use it. A limited liability partnership may not, and neither may a
 *     company.
 *   • Turnover must be within ₹2 crore, or ₹3 crore where cash receipts are no
 *     more than 5% of turnover.
 *   • Profit is 8% of turnover, or 6% of the part of it received through
 *     banking channels.
 *   • Nothing further is deducted — not business expenses, and not
 *     depreciation, which is treated as having been allowed even though it was
 *     never claimed.
 *
 * Whether it is the better option is a judgement about future years as well as
 * this one, because leaving the scheme after opting in carries consequences for
 * five years. This computes the comparison; it does not make the choice.
 */

/** Turnover ceiling, and the higher one where the business is mostly cashless. */
export const PRESUMPTIVE_LIMIT = 20_000_000;
export const PRESUMPTIVE_LIMIT_LOW_CASH = 30_000_000;

/** Cash may be no more than this share of turnover for the higher ceiling. */
export const LOW_CASH_SHARE_PERCENT = 5;

/** The two deemed-profit rates. */
export const RATE_ON_CASH = 8;
export const RATE_ON_DIGITAL = 6;

/** Section 44AB: turnover above which the accounts must be audited. */
export const AUDIT_LIMIT = 10_000_000;
export const AUDIT_LIMIT_LOW_CASH = 100_000_000;

const ELIGIBLE_ASSESSEES: ReadonlySet<Assessee> = new Set<Assessee>([
  "INDIVIDUAL",
  "HUF",
  "FIRM",
]);

export type PresumptiveResult = {
  turnover: Decimal;
  /** Share of turnover treated as received through banking channels, 0-100. */
  digitalSharePercent: number;
  digitalTurnover: Decimal;
  cashTurnover: Decimal;
  /** 8% of everything — the figure that holds whatever the receipt mix was. */
  incomeAtFullRate: Decimal;
  /** 6% on the banked part, 8% on the rest. */
  incomeAtSplitRate: Decimal;
  eligible: boolean;
  /** Why it is or is not available, in words. */
  reasons: string[];
  /** The ceiling that applied, given the receipt mix. */
  limitApplied: number;
};

/**
 * Deemed income under section 44AD.
 *
 * Two figures come back rather than one. The split rate depends on how much of
 * the turnover was *received* through banking channels, and a set of books
 * records receipts against the business rather than against individual
 * invoices — so the split is a proportion, not a traced figure, and presenting
 * a single number would be claiming a precision the data does not have.
 */
export function presumptiveIncome(params: {
  turnover: MoneyInput;
  /** Money received other than in cash during the year. */
  digitalReceipts: MoneyInput;
  /** Money received in cash during the year. */
  cashReceipts: MoneyInput;
  assessee: Assessee;
}): PresumptiveResult {
  const turnover = max(money(params.turnover), 0);
  const digitalReceipts = max(money(params.digitalReceipts), 0);
  const cashReceipts = max(money(params.cashReceipts), 0);
  const totalReceipts = add(digitalReceipts, cashReceipts);

  const digitalSharePercent =
    compare(totalReceipts, 0) > 0
      ? divide(digitalReceipts, totalReceipts)
          .times(100)
          .toDecimalPlaces(2)
          .toNumber()
      : 0;

  const digitalTurnover = percentOf(turnover, digitalSharePercent);
  const cashTurnover = subtract(turnover, digitalTurnover);

  const cashSharePercent = 100 - digitalSharePercent;
  const lowCash = cashSharePercent <= LOW_CASH_SHARE_PERCENT;
  const limitApplied = lowCash ? PRESUMPTIVE_LIMIT_LOW_CASH : PRESUMPTIVE_LIMIT;

  const reasons: string[] = [];
  let eligible = true;

  if (!ELIGIBLE_ASSESSEES.has(params.assessee)) {
    eligible = false;
    reasons.push(
      params.assessee === "LLP"
        ? "A limited liability partnership cannot use section 44AD."
        : "A company cannot use section 44AD.",
    );
  }

  if (compare(turnover, limitApplied) > 0) {
    eligible = false;
    reasons.push(
      `Turnover is above the ₹${(limitApplied / 10_000_000).toFixed(0)} crore ceiling that applies at this receipt mix.`,
    );
  } else if (lowCash && compare(turnover, PRESUMPTIVE_LIMIT) > 0) {
    reasons.push(
      "Turnover is above ₹2 crore, but cash receipts are within 5% of it, so the ₹3 crore ceiling applies.",
    );
  }

  if (eligible) {
    reasons.push(
      "The turnover and the kind of business are within what section 44AD allows. Whether the business itself qualifies — it must not be an agency, a commission business or a profession — is something to confirm.",
    );
  }

  return {
    turnover,
    digitalSharePercent,
    digitalTurnover,
    cashTurnover,
    incomeAtFullRate: percentOf(turnover, RATE_ON_CASH),
    incomeAtSplitRate: add(
      percentOf(digitalTurnover, RATE_ON_DIGITAL),
      percentOf(cashTurnover, RATE_ON_CASH),
    ),
    eligible,
    reasons,
    limitApplied,
  };
}

export type AuditApplicability = {
  required: boolean;
  limitApplied: number;
  /** Whether the ₹10 crore relaxation was available. */
  lowCash: boolean;
  reason: string;
};

/**
 * Whether the accounts must be audited — section 44AB.
 *
 * The ordinary ceiling is ₹1 crore of turnover. It becomes ₹10 crore where both
 * cash receipts and cash payments are within 5% of their totals, which is the
 * relaxation a shop that banks everything is entitled to and often does not
 * know about.
 */
export function auditApplicability(params: {
  turnover: MoneyInput;
  cashReceiptSharePercent: number;
  cashPaymentSharePercent: number;
}): AuditApplicability {
  const turnover = max(money(params.turnover), 0);
  const lowCash =
    params.cashReceiptSharePercent <= LOW_CASH_SHARE_PERCENT &&
    params.cashPaymentSharePercent <= LOW_CASH_SHARE_PERCENT;
  const limitApplied = lowCash ? AUDIT_LIMIT_LOW_CASH : AUDIT_LIMIT;
  const required = compare(turnover, limitApplied) > 0;

  return {
    required,
    limitApplied,
    lowCash,
    reason: required
      ? `Turnover is above the ₹${(limitApplied / 10_000_000).toFixed(0)} crore limit in section 44AB, so an audit appears to be required.`
      : lowCash
        ? "Cash receipts and cash payments are both within 5% of their totals, so the ₹10 crore limit applies rather than ₹1 crore — and turnover is within it."
        : `Turnover is within the ₹${(limitApplied / 10_000_000).toFixed(0)} crore limit in section 44AB.`,
  };
}

/**
 * Section 40A(3): cash paid to one person in one day.
 *
 * Above this, the whole payment is disallowed — not just the excess, which is
 * the part people are usually surprised by. The limit is ₹35,000 where the
 * payment is for hiring or leasing goods carriages.
 */
export const CASH_PAYMENT_LIMIT = 10_000;
export const CASH_PAYMENT_LIMIT_TRANSPORT = 35_000;
