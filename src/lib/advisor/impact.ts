import {
  abs,
  add,
  compare,
  divide,
  multiply,
  subtract,
  toStorageString,
  type MoneyInput,
} from "@/lib/money";
import {
  RULES,
  URGENCY_ORDER,
  type SuggestionKey,
  type Urgency,
} from "@/lib/advisor/catalogue";

/**
 * What a suggestion is worth, said as honestly as it can be said.
 *
 * There are three kinds of answer to "what is this worth", and conflating them
 * is how business software ends up quoting a confident figure for something
 * nobody could know:
 *
 *   recorded    — the figure is already in the books. Overdue receivables are
 *                 not an estimate of anything; that money has been earned and
 *                 invoiced and is sitting somewhere else.
 *   estimated   — the figure depends on an assumption, so the assumption is
 *                 printed beside it and the answer is a band rather than a
 *                 point. A band is not vagueness, it is the actual precision.
 *   unquantified — there is no defensible number. Saying so is a better answer
 *                 than a number that would be made up.
 */

export type Impact =
  | { kind: "recorded"; amount: string; what: string }
  | { kind: "estimated"; low: string; high: string; assumption: string }
  | { kind: "unquantified"; why: string };

/** How wide an estimate is drawn, either side of the arithmetic centre. */
export const ESTIMATE_SPREAD_PERCENT = 30;

/**
 * A share of the period's revenue at which an amount stops being background
 * noise and starts being worth interrupting somebody about.
 */
export const MATERIAL_SHARE_PERCENT = 10;

export function recorded(amount: MoneyInput, what: string): Impact {
  return { kind: "recorded", amount: toStorageString(amount), what };
}

/**
 * An estimate, widened into the band it always was.
 *
 * The centre is arithmetic; the band says that the arithmetic rests on
 * something that may not hold. Both ends are shown, and the page leads with the
 * band rather than with the middle of it.
 */
export function estimated(centre: MoneyInput, assumption: string): Impact {
  const spread = divide(ESTIMATE_SPREAD_PERCENT, 100);
  const low = multiply(centre, subtract(1, spread));
  const high = multiply(centre, add(1, spread));
  return {
    kind: "estimated",
    low: toStorageString(low),
    high: toStorageString(high),
    assumption,
  };
}

export function unquantified(why: string): Impact {
  return { kind: "unquantified", why };
}

/** The amount used for ordering. An estimate ranks on the low end of its band. */
export function rankingAmount(impact: Impact): string {
  if (impact.kind === "recorded") return impact.amount;
  if (impact.kind === "estimated") return impact.low;
  return "0.0000";
}

export type Suggestion = {
  key: SuggestionKey;
  /** What the books show, with the figures in it. Written by the detector. */
  observation: string;
  evidence: Record<string, string | number>;
  impact: Impact;
  urgency: Urgency;
  /** Set where the urgency was raised, so the page can say why. */
  escalated: boolean;
};

/**
 * Urgency starts fixed in the catalogue and rises for size.
 *
 * A suggestion carries a base urgency because the kind of problem matters:
 * running out of cash next month is more pressing than a long cash cycle
 * whatever the amounts. But an amount large enough against this shop's own
 * turnover earns a step up, because "worth a look when you can" is the wrong
 * label on a tenth of the year's revenue.
 *
 * Nothing is ever escalated to NOW from below SOON in one step, and nothing is
 * ever de-escalated: a small overdue balance is still money somebody owes.
 */
export function urgencyFor(params: {
  key: SuggestionKey;
  impact: Impact;
  periodRevenue: MoneyInput;
}): { urgency: Urgency; escalated: boolean } {
  const base = RULES[params.key].urgency;
  if (base === "NOW") return { urgency: base, escalated: false };
  if (compare(params.periodRevenue, 0) <= 0)
    return { urgency: base, escalated: false };

  const amount = abs(rankingAmount(params.impact));
  const share = multiply(divide(amount, params.periodRevenue), 100);
  if (compare(share, MATERIAL_SHARE_PERCENT) < 0)
    return { urgency: base, escalated: false };

  return {
    urgency: base === "SOON" ? "NOW" : "SOON",
    escalated: true,
  };
}

/**
 * The order they are read in.
 *
 * Urgency first, then the amount at stake, then the catalogue order so the list
 * does not shuffle between runs on equal figures. Effort deliberately does not
 * enter the ordering — it is shown so the reader can pick the easy one, which
 * is their judgement to make rather than the software's.
 */
export function rank(suggestions: readonly Suggestion[]): Suggestion[] {
  const order = new Map(
    Object.keys(RULES).map((key, index) => [key, index] as const),
  );
  return [...suggestions].sort((a, b) => {
    const byUrgency = URGENCY_ORDER[b.urgency] - URGENCY_ORDER[a.urgency];
    if (byUrgency !== 0) return byUrgency;
    const byAmount = compare(rankingAmount(b.impact), rankingAmount(a.impact));
    if (byAmount !== 0) return byAmount;
    return (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0);
  });
}
