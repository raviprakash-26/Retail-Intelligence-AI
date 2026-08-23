import {
  add,
  compare,
  Decimal,
  max,
  money,
  percentOf,
  subtract,
  type MoneyInput,
} from "@/lib/money";

/**
 * Income tax on business income.
 *
 * **Every figure this produces is an estimate.** It is arithmetic applied to a
 * rate table, not advice, and it does not know about the things that most often
 * change the answer for a real person: income from other sources, house
 * property, capital gains, a spouse's income clubbed in, Chapter VI-A
 * deductions, losses carried forward from earlier years, or an election into
 * one of the concessional company regimes. The interface says so wherever a
 * number from here appears, and the working paper shows the bands so an
 * accountant can check the arithmetic rather than take it on faith.
 *
 * Rates live in a table keyed by assessment year, not scattered through the
 * code, because they change every February. When they change, a new table is
 * added and the old one stays — a return being prepared late for an earlier
 * year must be computed on that year's law, not on this year's.
 */

export type TaxRegime = "NEW" | "OLD";

/** Who is being taxed. The regime choice only exists for the first two. */
export type Assessee = "INDIVIDUAL" | "HUF" | "FIRM" | "LLP" | "COMPANY";

/** Only affects the basic exemption, and only under the old regime. */
export type AgeBand = "BELOW_60" | "SENIOR" | "SUPER_SENIOR";

export type SlabBand = {
  /** Inclusive upper bound, in rupees. `null` on the topmost band. */
  upTo: number | null;
  ratePercent: number;
};

export type SurchargeBand = {
  /** Surcharge applies to income strictly above this. */
  above: number;
  ratePercent: number;
};

export type RebateRule = {
  /** Rebate is available only when total income is at most this. */
  upToIncome: number;
  /** Capped at this much tax. */
  maxRebate: number;
  /**
   * Whether tax just above the threshold is limited to the excess income.
   * The new regime has this relief; the old one does not.
   */
  marginalRelief: boolean;
};

export type RateTable = {
  assessmentYear: string;
  financialYear: string;
  /** Named in the interface so nobody has to guess which law was applied. */
  basis: string;
  /**
   * True where the table is an earlier year's rates carried forward because
   * this year's Finance Act has not been entered yet.
   *
   * A carried-forward table is usually right — most years most rates do not
   * move — and it is exactly the kind of "usually right" that has to be said
   * out loud rather than assumed. The interface marks every figure computed
   * from one.
   */
  provisional: boolean;
  cessPercent: number;
  slabs: Record<TaxRegime, Record<AgeBand, SlabBand[]>>;
  rebate: Record<TaxRegime, RebateRule | null>;
  /** Surcharge bands, highest first, per kind of assessee. */
  surcharge: {
    individual: Record<TaxRegime, SurchargeBand[]>;
    firm: SurchargeBand[];
    company: SurchargeBand[];
  };
  flatRatePercent: {
    firm: number;
    company: number;
  };
};

const OLD_SLABS_BELOW_60: SlabBand[] = [
  { upTo: 250_000, ratePercent: 0 },
  { upTo: 500_000, ratePercent: 5 },
  { upTo: 1_000_000, ratePercent: 20 },
  { upTo: null, ratePercent: 30 },
];

/**
 * The rate table for assessment year 2026-27 (the year ended 31 March 2026).
 *
 * The new regime slabs are the ones introduced by the Finance Act 2025, under
 * which a resident individual with total income up to ₹12,00,000 pays nothing
 * once the section 87A rebate is applied.
 */
const AY_2026_27: RateTable = {
  assessmentYear: "2026-27",
  financialYear: "2025-26",
  basis: "Finance Act 2025 rates for assessment year 2026-27",
  provisional: false,
  cessPercent: 4,
  slabs: {
    NEW: {
      // Age makes no difference under the new regime.
      BELOW_60: [
        { upTo: 400_000, ratePercent: 0 },
        { upTo: 800_000, ratePercent: 5 },
        { upTo: 1_200_000, ratePercent: 10 },
        { upTo: 1_600_000, ratePercent: 15 },
        { upTo: 2_000_000, ratePercent: 20 },
        { upTo: 2_400_000, ratePercent: 25 },
        { upTo: null, ratePercent: 30 },
      ],
      SENIOR: [],
      SUPER_SENIOR: [],
    },
    OLD: {
      BELOW_60: OLD_SLABS_BELOW_60,
      SENIOR: [
        { upTo: 300_000, ratePercent: 0 },
        { upTo: 500_000, ratePercent: 5 },
        { upTo: 1_000_000, ratePercent: 20 },
        { upTo: null, ratePercent: 30 },
      ],
      SUPER_SENIOR: [
        { upTo: 500_000, ratePercent: 0 },
        { upTo: 1_000_000, ratePercent: 20 },
        { upTo: null, ratePercent: 30 },
      ],
    },
  },
  rebate: {
    NEW: { upToIncome: 1_200_000, maxRebate: 60_000, marginalRelief: true },
    OLD: { upToIncome: 500_000, maxRebate: 12_500, marginalRelief: false },
  },
  surcharge: {
    individual: {
      // Capped at 25% under the new regime; the 37% band does not exist there.
      NEW: [
        { above: 20_000_000, ratePercent: 25 },
        { above: 10_000_000, ratePercent: 15 },
        { above: 5_000_000, ratePercent: 10 },
      ],
      OLD: [
        { above: 50_000_000, ratePercent: 37 },
        { above: 20_000_000, ratePercent: 25 },
        { above: 10_000_000, ratePercent: 15 },
        { above: 5_000_000, ratePercent: 10 },
      ],
    },
    firm: [{ above: 10_000_000, ratePercent: 12 }],
    company: [
      { above: 100_000_000, ratePercent: 12 },
      { above: 10_000_000, ratePercent: 7 },
    ],
  },
  flatRatePercent: {
    firm: 30,
    // The ordinary rate for a small domestic company. A company that has
    // elected into section 115BAA or 115BAB is taxed differently, and the
    // working paper says so rather than silently applying this.
    company: 25,
  },
};

/** Age makes no difference under the new regime, so all three bands share one table. */
AY_2026_27.slabs.NEW.SENIOR = AY_2026_27.slabs.NEW.BELOW_60;
AY_2026_27.slabs.NEW.SUPER_SENIOR = AY_2026_27.slabs.NEW.BELOW_60;

/**
 * Assessment year 2027-28, carried forward.
 *
 * A shop that trades through the year needs a running estimate of what it will
 * owe, and it needs it long before the Finance Act for the year is passed.
 * Refusing to compute anything would be the safe-looking choice and the less
 * useful one — so the previous year's rates are used, spread by `provisional`
 * through everything computed from them, and the interface says on the face of
 * the figure that the law may have moved. When the new rates are known this
 * becomes a table of its own and the flag comes off.
 */
const AY_2027_28: RateTable = {
  ...AY_2026_27,
  assessmentYear: "2027-28",
  financialYear: "2026-27",
  basis:
    "Assessment year 2026-27 rates, carried forward — the Finance Act for this year has not been entered",
  provisional: true,
};

const RATE_TABLES: Record<string, RateTable> = {
  "2026-27": AY_2026_27,
  "2027-28": AY_2027_28,
};

/** The assessment year a financial year is assessed in: 2025-26 → 2026-27. */
export function assessmentYearFor(financialYearStart: number): string {
  return `${financialYearStart + 1}-${String((financialYearStart + 2) % 100).padStart(2, "0")}`;
}

/**
 * The rate table for an assessment year.
 *
 * Returns `null` rather than quietly substituting another year's rates. A
 * computation on the wrong year's law looks exactly like a correct one, which
 * is the worst way for this to fail.
 */
export function rateTableFor(assessmentYear: string): RateTable | null {
  return RATE_TABLES[assessmentYear] ?? null;
}

export function knownAssessmentYears(): string[] {
  return Object.keys(RATE_TABLES).sort();
}

/** Whether the regime choice means anything for this assessee. */
export function regimeApplies(assessee: Assessee): boolean {
  return assessee === "INDIVIDUAL" || assessee === "HUF";
}

export type BandResult = {
  from: number;
  /** `null` on the topmost band. */
  to: number | null;
  ratePercent: number;
  /** How much of the income fell in this band. */
  income: Decimal;
  tax: Decimal;
};

export type TaxComputation = {
  assessmentYear: string;
  financialYear: string;
  basis: string;
  /** True where the rates were carried forward rather than legislated. */
  provisional: boolean;
  assessee: Assessee;
  regime: TaxRegime;
  ageBand: AgeBand;
  totalIncome: Decimal;
  /** Empty for a flat-rate assessee — a firm has no slabs. */
  bands: BandResult[];
  /** Set for a flat-rate assessee. */
  flatRatePercent: number | null;
  taxOnIncome: Decimal;
  rebate: Decimal;
  /** Why the rebate is what it is, in words, or `null` when none applies. */
  rebateNote: string | null;
  taxAfterRebate: Decimal;
  surchargeRatePercent: number;
  surcharge: Decimal;
  /** Reduction where crossing a surcharge threshold would cost more than it earned. */
  marginalRelief: Decimal;
  cessPercent: number;
  cess: Decimal;
  totalTax: Decimal;
  /** Section 288B rounds the final liability to the nearest ten rupees. */
  roundedTax: Decimal;
  effectiveRatePercent: number | null;
};

function slabTax(income: Decimal, bands: SlabBand[]): BandResult[] {
  const results: BandResult[] = [];
  let floor = 0;

  for (const band of bands) {
    const ceiling = band.upTo;
    const width =
      ceiling === null
        ? max(subtract(income, floor), 0)
        : max(subtract(min2(income, ceiling), floor), 0);

    results.push({
      from: floor,
      to: ceiling,
      ratePercent: band.ratePercent,
      income: width,
      tax: percentOf(width, band.ratePercent),
    });

    if (ceiling === null) break;
    floor = ceiling;
    if (compare(income, ceiling) <= 0) break;
  }

  return results;
}

/** `min` against a plain number, kept local so the intent reads clearly above. */
function min2(value: Decimal, ceiling: number): Decimal {
  return compare(value, ceiling) <= 0 ? value : money(ceiling);
}

/** Tax before rebate, surcharge and cess, at a given total income. */
function baseTax(
  income: Decimal,
  table: RateTable,
  assessee: Assessee,
  regime: TaxRegime,
  ageBand: AgeBand,
): { bands: BandResult[]; tax: Decimal; flatRatePercent: number | null } {
  if (assessee === "FIRM" || assessee === "LLP") {
    const rate = table.flatRatePercent.firm;
    return { bands: [], tax: percentOf(income, rate), flatRatePercent: rate };
  }
  if (assessee === "COMPANY") {
    const rate = table.flatRatePercent.company;
    return { bands: [], tax: percentOf(income, rate), flatRatePercent: rate };
  }

  const bands = slabTax(income, table.slabs[regime][ageBand]);
  return {
    bands,
    tax: add(...bands.map((band) => band.tax)),
    flatRatePercent: null,
  };
}

function surchargeBandsFor(
  table: RateTable,
  assessee: Assessee,
  regime: TaxRegime,
): SurchargeBand[] {
  if (assessee === "FIRM" || assessee === "LLP") return table.surcharge.firm;
  if (assessee === "COMPANY") return table.surcharge.company;
  return table.surcharge.individual[regime];
}

/**
 * Applies the section 87A rebate.
 *
 * Under the new regime the rebate does not simply vanish one rupee above the
 * threshold: tax on income just over it is limited to the excess, so earning
 * ₹1 more never costs ₹60,000. That relief is the reason this is not a single
 * comparison.
 */
function applyRebate(
  income: Decimal,
  tax: Decimal,
  rule: RebateRule | null,
  assessee: Assessee,
): { rebate: Decimal; note: string | null } {
  // The rebate is for resident individuals only.
  if (!rule || assessee !== "INDIVIDUAL")
    return { rebate: money(0), note: null };

  if (compare(income, rule.upToIncome) <= 0) {
    const rebate =
      compare(tax, rule.maxRebate) <= 0 ? tax : money(rule.maxRebate);
    return {
      rebate,
      note: `Total income is within ₹${rule.upToIncome.toLocaleString("en-IN")}, so the section 87A rebate applies.`,
    };
  }

  if (!rule.marginalRelief) return { rebate: money(0), note: null };

  // Marginal relief: tax is capped at the income above the threshold.
  const excess = subtract(income, rule.upToIncome);
  if (compare(tax, excess) <= 0) return { rebate: money(0), note: null };

  return {
    rebate: subtract(tax, excess),
    note: `Total income is just above ₹${rule.upToIncome.toLocaleString("en-IN")}, so tax is limited to the income above that threshold.`,
  };
}

/**
 * Marginal relief on surcharge.
 *
 * Crossing a surcharge threshold must never leave the assessee worse off than
 * stopping at it. The Finance Act says it as a ceiling: income-tax and
 * surcharge on the actual income shall not exceed income-tax **and surcharge**
 * on a total income of the threshold, by more than the income above it.
 *
 * The words "and surcharge" are the whole of this. Only the lowest threshold
 * has no surcharge sitting at it — fifty lakh is the point where surcharge
 * begins — so a ceiling built from the slabs alone is right there and nowhere
 * else. At a crore the ceiling has to carry the 10% that a crore already
 * attracts, at two crore the 15%, and so on.
 *
 * Left out, the relief overshot by exactly the surcharge at the threshold, and
 * it overshot in the direction that reads as a reward: at ten lakh of tax on a
 * crore, earning ₹100 more took ₹2,92,396 *off* the bill. Relief that pays the
 * assessee to cross a threshold is not relief, and a working paper showing tax
 * falling as income rises is one an assessing officer will ask about.
 *
 * The ceiling is therefore the whole computation run again at the threshold,
 * not the slabs alone. That is recursive by nature — the figure at a crore is
 * itself after the relief owed at fifty lakh — and it terminates because each
 * call is made at a strictly lower band.
 */
function surchargeMarginalRelief(params: {
  income: Decimal;
  taxPlusSurcharge: Decimal;
  threshold: number;
  table: RateTable;
  assessee: Assessee;
  regime: TaxRegime;
  ageBand: AgeBand;
}): Decimal {
  const atThreshold = taxAndSurcharge(
    money(params.threshold),
    params.table,
    params.assessee,
    params.regime,
    params.ageBand,
  ).beforeCess;

  const excessIncome = subtract(params.income, params.threshold);
  const ceiling = add(atThreshold, excessIncome);
  const relief = subtract(params.taxPlusSurcharge, ceiling);
  return compare(relief, 0) > 0 ? relief : money(0);
}

type TaxAndSurcharge = {
  bands: BandResult[];
  flatRatePercent: number | null;
  taxOnIncome: Decimal;
  rebate: Decimal;
  rebateNote: string | null;
  taxAfterRebate: Decimal;
  surchargeRatePercent: number;
  surcharge: Decimal;
  marginalRelief: Decimal;
  /** Income-tax and surcharge after both reliefs, before cess. */
  beforeCess: Decimal;
};

/**
 * Everything up to but not including cess, at a given total income.
 *
 * Split out from `computeIncomeTax` because the surcharge ceiling above needs
 * exactly this figure at the threshold, and needs it to be the same arithmetic
 * rather than a second reading of the same rule.
 */
function taxAndSurcharge(
  income: Decimal,
  table: RateTable,
  assessee: Assessee,
  regime: TaxRegime,
  ageBand: AgeBand,
): TaxAndSurcharge {
  const base = baseTax(income, table, assessee, regime, ageBand);
  const { rebate, note } = applyRebate(
    income,
    base.tax,
    table.rebate[regime],
    assessee,
  );
  const taxAfterRebate = subtract(base.tax, rebate);

  const bands = surchargeBandsFor(table, assessee, regime);
  const applicable = bands.find((band) => compare(income, band.above) > 0);
  const surcharge = applicable
    ? percentOf(taxAfterRebate, applicable.ratePercent)
    : money(0);

  const marginalRelief = applicable
    ? surchargeMarginalRelief({
        income,
        taxPlusSurcharge: add(taxAfterRebate, surcharge),
        threshold: applicable.above,
        table,
        assessee,
        regime,
        ageBand,
      })
    : money(0);

  return {
    bands: base.bands,
    flatRatePercent: base.flatRatePercent,
    taxOnIncome: base.tax,
    rebate,
    rebateNote: note,
    taxAfterRebate,
    surchargeRatePercent: applicable?.ratePercent ?? 0,
    surcharge,
    marginalRelief,
    beforeCess: max(
      subtract(add(taxAfterRebate, surcharge), marginalRelief),
      0,
    ),
  };
}

/** Section 288B: the final liability is rounded to the nearest ten rupees. */
export function roundToNearestTen(value: MoneyInput): Decimal {
  return money(value)
    .dividedBy(10)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .times(10);
}

export function computeIncomeTax(params: {
  totalIncome: MoneyInput;
  table: RateTable;
  assessee: Assessee;
  regime: TaxRegime;
  ageBand?: AgeBand;
}): TaxComputation {
  const { table, assessee } = params;
  const regime = regimeApplies(assessee) ? params.regime : "NEW";
  const ageBand = params.ageBand ?? "BELOW_60";
  // A loss is not negative tax. Income below zero is taxed at nothing, and the
  // loss itself is carried forward, which is outside what this computes.
  const totalIncome = max(money(params.totalIncome), 0);

  const computed = taxAndSurcharge(
    totalIncome,
    table,
    assessee,
    regime,
    ageBand,
  );
  const cess = percentOf(computed.beforeCess, table.cessPercent);
  const totalTax = add(computed.beforeCess, cess);

  return {
    assessmentYear: table.assessmentYear,
    financialYear: table.financialYear,
    basis: table.basis,
    provisional: table.provisional,
    assessee,
    regime,
    ageBand,
    totalIncome,
    bands: computed.bands,
    flatRatePercent: computed.flatRatePercent,
    taxOnIncome: computed.taxOnIncome,
    rebate: computed.rebate,
    rebateNote: computed.rebateNote,
    taxAfterRebate: computed.taxAfterRebate,
    surchargeRatePercent: computed.surchargeRatePercent,
    surcharge: computed.surcharge,
    marginalRelief: computed.marginalRelief,
    cessPercent: table.cessPercent,
    cess,
    totalTax,
    roundedTax: roundToNearestTen(totalTax),
    effectiveRatePercent:
      compare(totalIncome, 0) > 0
        ? totalTax
            .dividedBy(totalIncome)
            .times(100)
            .toDecimalPlaces(2)
            .toNumber()
        : null,
  };
}

/**
 * Advance tax instalments.
 *
 * Section 211: 15% by 15 June, 45% by 15 September, 75% by 15 December and the
 * whole of it by 15 March. A business taxed presumptively under section 44AD
 * has one instalment instead — the whole amount by 15 March.
 */
export type AdvanceTaxInstalment = {
  dueDate: string;
  cumulativePercent: number;
  cumulativeAmount: Decimal;
  /** What this instalment alone comes to. */
  instalmentAmount: Decimal;
  /** True when the date has already passed. */
  elapsed: boolean;
};

const ORDINARY_INSTALMENTS: ReadonlyArray<{ month: number; percent: number }> =
  [
    { month: 6, percent: 15 },
    { month: 9, percent: 45 },
    { month: 12, percent: 75 },
    { month: 3, percent: 100 },
  ];

export function advanceTaxSchedule(params: {
  totalTax: MoneyInput;
  /** Calendar year the financial year starts in: 2025 for FY 2025-26. */
  financialYearStart: number;
  presumptive?: boolean;
  asOf?: Date;
}): AdvanceTaxInstalment[] {
  const tax = max(money(params.totalTax), 0);
  const asOf = params.asOf ?? new Date();
  const rows = params.presumptive
    ? [{ month: 3, percent: 100 }]
    : ORDINARY_INSTALMENTS;

  let previous = money(0);
  return rows.map(({ month, percent }) => {
    // June, September and December fall in the first calendar year; March in
    // the next one.
    const year =
      month === 3 ? params.financialYearStart + 1 : params.financialYearStart;
    const dueDate = new Date(Date.UTC(year, month - 1, 15));
    const cumulativeAmount = percentOf(tax, percent);
    const instalmentAmount = subtract(cumulativeAmount, previous);
    previous = cumulativeAmount;

    return {
      dueDate: dueDate.toISOString().slice(0, 10),
      cumulativePercent: percent,
      cumulativeAmount,
      instalmentAmount,
      elapsed: asOf.getTime() > dueDate.getTime(),
    };
  });
}

/**
 * Whether advance tax is due at all.
 *
 * Section 208: only where the liability for the year is ₹10,000 or more.
 */
export const ADVANCE_TAX_THRESHOLD = 10_000;

export function advanceTaxDue(totalTax: MoneyInput): boolean {
  return compare(money(totalTax), ADVANCE_TAX_THRESHOLD) >= 0;
}

/** Words for an assessee, for anything a person reads. */
export const ASSESSEE_LABELS: Record<Assessee, string> = {
  INDIVIDUAL: "Individual",
  HUF: "Hindu Undivided Family",
  FIRM: "Partnership firm",
  LLP: "Limited liability partnership",
  COMPANY: "Company",
};

export const REGIME_LABELS: Record<TaxRegime, string> = {
  NEW: "New regime",
  OLD: "Old regime",
};
