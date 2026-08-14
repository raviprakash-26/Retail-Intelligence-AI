import type { Ratio, RatioKey } from "@/lib/analytics/ratios";

/**
 * A health indicator, and what it is not.
 *
 * **This is not a credit score.** It is not issued by a bureau, no lender sees
 * it, it has no bearing on any loan, and it is not comparable with anybody
 * else's business. It is an arithmetic summary of five ratios out of this
 * shop's own books, computed here so the owner has one number to watch move
 * rather than eleven. The interface says all of that, every time it shows the
 * figure.
 *
 * Two rules keep it honest.
 *
 * **Every component shows its rule and the figure it came from**, so the score
 * can be re-derived by hand. A composite nobody can reproduce is a number to be
 * taken on faith, and financial software should never ask for faith.
 *
 * **Too little to measure means no score**, not a low one. A shop three weeks
 * into trading has nothing to say about collection days, and scoring it 20 out
 * of 100 would be a judgement about missing data rather than about the
 * business.
 */

export type HealthComponent = {
  key: string;
  label: string;
  /** 0–100, or null where the underlying ratio could not be computed. */
  score: number | null;
  /** Share of the total, before renormalising over what could be measured. */
  weight: number;
  /** The rule applied, in words, so the figure can be checked by hand. */
  rule: string;
  /** What the ratio actually was. */
  observed: string;
};

export type HealthBand = "strong" | "steady" | "strained";

export type HealthIndicator = {
  /** 0–100, or null when too little of the business could be measured. */
  score: number | null;
  band: HealthBand | null;
  components: HealthComponent[];
  /** How many components carried a score. */
  measured: number;
  /** Why there is no score, when there is none. */
  unavailable: string | null;
};

/** Fewer measurable components than this and no score is offered at all. */
export const MINIMUM_COMPONENTS = 3;

/** Maps a value onto 0–100 between two ends, clamped, in either direction. */
function scale(value: number, worst: number, best: number): number {
  if (worst === best) return 100;
  const raw = ((value - worst) / (best - worst)) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function find(ratios: readonly Ratio[], key: RatioKey): Ratio | undefined {
  return ratios.find((ratio) => ratio.key === key);
}

function observed(ratio: Ratio | undefined, suffix: string): string {
  if (!ratio || ratio.value === null) return "not measurable in this period";
  return `${ratio.value}${suffix}`;
}

export function computeHealth(ratios: readonly Ratio[]): HealthIndicator {
  const netMargin = find(ratios, "netMargin");
  const currentRatio = find(ratios, "currentRatio");
  const receivableDays = find(ratios, "receivableDays");
  const inventoryDays = find(ratios, "inventoryDays");
  const expenseRatio = find(ratios, "expenseRatio");
  const grossMargin = find(ratios, "grossMargin");

  // Running costs are scored against gross margin rather than against sales:
  // 40% of sales spent on rent and salaries is comfortable on a 60% margin and
  // fatal on a 25% one, and a rule that ignores that would rank shops by trade
  // rather than by how they are run.
  const costCover =
    expenseRatio?.value != null &&
    grossMargin?.value != null &&
    grossMargin.value > 0
      ? (expenseRatio.value / grossMargin.value) * 100
      : null;

  const components: HealthComponent[] = [
    {
      key: "profitability",
      label: "Profitability",
      weight: 30,
      score: netMargin?.value == null ? null : scale(netMargin.value, 0, 10),
      rule: "Net margin: nil scores 0, 10% or better scores 100.",
      observed: observed(netMargin, "% net margin"),
    },
    {
      key: "liquidity",
      label: "Ability to pay what is due",
      weight: 25,
      score:
        currentRatio?.value == null ? null : scale(currentRatio.value, 0.5, 2),
      rule: "Current ratio: 0.5 scores 0, 2.0 or better scores 100.",
      observed: observed(currentRatio, " current ratio"),
    },
    {
      key: "collection",
      label: "Getting paid",
      weight: 20,
      score:
        receivableDays?.value == null
          ? null
          : scale(receivableDays.value, 90, 15),
      rule: "Collection days: 90 days scores 0, 15 days or fewer scores 100.",
      observed: observed(receivableDays, " days to collect"),
    },
    {
      key: "stock",
      label: "Stock moving",
      weight: 15,
      score:
        inventoryDays?.value == null
          ? null
          : scale(inventoryDays.value, 180, 30),
      rule: "Days of stock: 180 days scores 0, 30 days or fewer scores 100.",
      observed: observed(inventoryDays, " days of stock"),
    },
    {
      key: "costs",
      label: "Costs under the margin",
      weight: 10,
      score: costCover === null ? null : scale(costCover, 100, 50),
      rule: "Running costs against gross margin: consuming all of it scores 0, half of it scores 100.",
      observed:
        costCover === null
          ? "not measurable in this period"
          : `running costs are ${Math.round(costCover)}% of gross margin`,
    },
  ];

  const measured = components.filter((entry) => entry.score !== null);

  if (measured.length < MINIMUM_COMPONENTS) {
    return {
      score: null,
      band: null,
      components,
      measured: measured.length,
      unavailable:
        "There is not enough trading in this period to say anything useful. A number here would be a judgement about missing data rather than about the business.",
    };
  }

  const totalWeight = measured.reduce((sum, entry) => sum + entry.weight, 0);
  const weighted = measured.reduce(
    (sum, entry) => sum + (entry.score ?? 0) * entry.weight,
    0,
  );
  const score = Math.round(weighted / totalWeight);

  return {
    score,
    band: score >= 70 ? "strong" : score >= 45 ? "steady" : "strained",
    components,
    measured: measured.length,
    unavailable: null,
  };
}

export const BAND_LABELS: Record<HealthBand, string> = {
  strong: "Holding up well",
  steady: "Steady, with room to improve",
  strained: "Under strain",
};

/**
 * The sentence that has to accompany the figure wherever it appears.
 *
 * Kept here rather than in a component so a second place that shows the score
 * cannot quietly show it without the caveat.
 */
export const HEALTH_DISCLAIMER =
  "This is our own summary of your books, not a credit score. No bureau issues it, no lender sees it, and it has no bearing on any loan you apply for.";
