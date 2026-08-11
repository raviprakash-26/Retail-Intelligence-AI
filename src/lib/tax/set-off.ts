import {
  add,
  compare,
  money,
  subtract,
  type Decimal,
  type MoneyInput,
} from "@/lib/money";

/**
 * Setting input tax credit against output tax.
 *
 * The order is prescribed, not a matter of preference, and getting it wrong
 * produces a payable that is arithmetically defensible and legally wrong. Rule
 * 88A and section 49(5) of the CGST Act, in the order they apply:
 *
 *   1. IGST credit is used first, and must be exhausted before any CGST or SGST
 *      credit is touched. It may go against IGST, then CGST, then SGST.
 *   2. CGST credit goes against CGST, then against IGST.
 *   3. SGST credit goes against SGST, then against IGST.
 *   4. CGST credit may never be set against SGST, or SGST against CGST. The two
 *      belong to different governments; the set-off would move money between
 *      them.
 *
 * Pure, so the whole table can be tested without a database, and shared by the
 * working paper and by anything later that needs the same answer.
 *
 * This computes a preparation figure. It is not a filing, and the interface
 * says so wherever the number appears.
 */

export type TaxHeads = {
  igst: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  cess: Decimal;
};

export type TaxHeadsInput = {
  igst?: MoneyInput;
  cgst?: MoneyInput;
  sgst?: MoneyInput;
  cess?: MoneyInput;
};

export function heads(input: TaxHeadsInput = {}): TaxHeads {
  return {
    igst: money(input.igst ?? 0),
    cgst: money(input.cgst ?? 0),
    sgst: money(input.sgst ?? 0),
    cess: money(input.cess ?? 0),
  };
}

/** One application of credit against a liability. */
export type SetOffStep = {
  /** Which credit was used. */
  from: keyof TaxHeads;
  /** Which liability it was set against. */
  against: keyof TaxHeads;
  amount: Decimal;
};

export type SetOffResult = {
  /** What was owed before any credit was applied. */
  liability: TaxHeads;
  /** Credit available at the start. */
  credit: TaxHeads;
  /** Each application, in the order the rules require. */
  steps: SetOffStep[];
  /** Still owed after credit — this is what would be paid in cash. */
  payable: TaxHeads;
  /** Credit left over, carried forward to the next period. */
  carriedForward: TaxHeads;
  /** Total cash payable across all heads. */
  totalPayable: Decimal;
  /** Total credit carried forward. */
  totalCarriedForward: Decimal;
};

/** The order credit is applied in. IGST first, and exhausted, before the rest. */
const ORDER: ReadonlyArray<{ from: keyof TaxHeads; against: keyof TaxHeads }> =
  [
    { from: "igst", against: "igst" },
    { from: "igst", against: "cgst" },
    { from: "igst", against: "sgst" },
    { from: "cgst", against: "cgst" },
    { from: "cgst", against: "igst" },
    { from: "sgst", against: "sgst" },
    { from: "sgst", against: "igst" },
    // Cess is ring-fenced: it can only ever be set against cess.
    { from: "cess", against: "cess" },
  ];

export function applySetOff(
  liabilityInput: TaxHeadsInput,
  creditInput: TaxHeadsInput,
): SetOffResult {
  const liability = heads(liabilityInput);
  const credit = heads(creditInput);

  const owed: TaxHeads = { ...liability };
  const available: TaxHeads = { ...credit };
  const steps: SetOffStep[] = [];

  for (const { from, against } of ORDER) {
    const canUse = available[from];
    const stillOwed = owed[against];
    if (compare(canUse, 0) <= 0 || compare(stillOwed, 0) <= 0) continue;

    const applied = compare(canUse, stillOwed) <= 0 ? canUse : stillOwed;
    available[from] = subtract(canUse, applied);
    owed[against] = subtract(stillOwed, applied);
    steps.push({ from, against, amount: applied });
  }

  return {
    liability,
    credit,
    steps,
    payable: owed,
    carriedForward: available,
    totalPayable: add(owed.igst, owed.cgst, owed.sgst, owed.cess),
    totalCarriedForward: add(
      available.igst,
      available.cgst,
      available.sgst,
      available.cess,
    ),
  };
}

/** Words for a head, for anything a person reads. */
export const HEAD_LABELS: Record<keyof TaxHeads, string> = {
  igst: "IGST",
  cgst: "CGST",
  sgst: "SGST",
  cess: "Cess",
};

/**
 * The set-off in a sentence, for the working paper.
 *
 * "₹1,200 of IGST credit set against CGST" is a thing an accountant can check.
 * A table of numbers with no explanation is a thing they have to reverse
 * engineer.
 */
export function describeStep(step: SetOffStep): string {
  return step.from === step.against
    ? `${HEAD_LABELS[step.from]} credit against ${HEAD_LABELS[step.against]}`
    : `${HEAD_LABELS[step.from]} credit against ${HEAD_LABELS[step.against]}`;
}

/** Total of a set of heads. */
export function totalHeads(value: TaxHeads): Decimal {
  return add(value.igst, value.cgst, value.sgst, value.cess);
}
