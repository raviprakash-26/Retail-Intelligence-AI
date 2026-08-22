import {
  add,
  compare,
  max,
  min,
  money,
  subtract,
  type Decimal,
  type MoneyInput,
} from "@/lib/money";

/**
 * Setting input tax credit against output tax.
 *
 * Almost all of the order is prescribed, and getting it wrong produces a
 * payable that is arithmetically defensible and legally wrong. Rule 88A and
 * section 49(5) of the CGST Act, in the order they apply:
 *
 *   1. IGST credit is used first, and must be exhausted before any CGST or SGST
 *      credit is touched. It goes against IGST before anything else.
 *   2. What is left of it may go to CGST and SGST **in any order and in any
 *      proportion** — rule 88A says so in those words. This is the one part
 *      that is a choice, it belongs to the taxpayer, and it is worth money.
 *      See `directIgst`.
 *   3. CGST credit goes against CGST, then against IGST.
 *   4. SGST credit goes against SGST, then against IGST.
 *   5. CGST credit may never be set against SGST, or SGST against CGST. The two
 *      belong to different governments; the set-off would move money between
 *      them.
 *
 * Rule 5 is what makes rule 2 matter. Since neither of those credits can cross,
 * IGST credit is the only credit that can reach either head, and where it is
 * spent decides how much of the tax has to be found in cash.
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

/**
 * The order credit is applied in, once the IGST pool has been directed.
 *
 * IGST comes first and is exhausted before anything else is touched, which is
 * why its own entries lead. Everything after it is fixed by section 49(5): each
 * of CGST and SGST goes against its own head before it may go against IGST.
 */
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

/**
 * How much IGST credit to spend on each of CGST and SGST.
 *
 * This is the one thing the rules leave open. Rule 88A fixes IGST against IGST
 * first and then says the remainder may go to central and State tax "in any
 * order and in any proportion" — so the split is the taxpayer's to make, and it
 * decides how much comes out of the bank.
 *
 * It matters because CGST credit cannot pay SGST and SGST credit cannot pay
 * CGST. IGST credit is the only credit that can reach either head, which makes
 * it worth spending where a head's own credit cannot follow. Sent to CGST first
 * regardless — the obvious reading of a list that names CGST before SGST — it
 * pays off a liability the CGST credit was going to cover anyway, and the SGST
 * shortfall it could have met is paid in cash while that CGST credit carries
 * forward unused. A shop buying some stock interstate and some locally, then
 * selling locally, is in exactly that position every month.
 *
 * So the shortfalls are met first, and only what is left over follows the plain
 * order. Where the pool cannot cover both shortfalls the cash total is the same
 * whichever way it is divided, and meeting them in order keeps the answer
 * reproducible.
 */
function directIgst(owed: TaxHeads, available: TaxHeads): void {
  const shortfall = (head: "cgst" | "sgst") =>
    max(subtract(owed[head], available[head]), 0);

  const toCgst = min(available.igst, shortfall("cgst"));
  const toSgst = min(subtract(available.igst, toCgst), shortfall("sgst"));

  // Held back from the pool so the ordinary pass below cannot spend it
  // elsewhere; the pass then applies it to the head it was set aside for.
  available.igst = subtract(available.igst, add(toCgst, toSgst));
  owed.cgst = subtract(owed.cgst, toCgst);
  owed.sgst = subtract(owed.sgst, toSgst);
}

export function applySetOff(
  liabilityInput: TaxHeadsInput,
  creditInput: TaxHeadsInput,
): SetOffResult {
  const liability = heads(liabilityInput);
  const credit = heads(creditInput);

  const owed: TaxHeads = { ...liability };
  const available: TaxHeads = { ...credit };
  const steps: SetOffStep[] = [];

  const apply = (from: keyof TaxHeads, against: keyof TaxHeads) => {
    const canUse = available[from];
    const stillOwed = owed[against];
    if (compare(canUse, 0) <= 0 || compare(stillOwed, 0) <= 0) return;

    const applied = compare(canUse, stillOwed) <= 0 ? canUse : stillOwed;
    available[from] = subtract(canUse, applied);
    owed[against] = subtract(stillOwed, applied);

    // One line per pair, so the working paper reads as "IGST credit against
    // SGST" once rather than twice for the same movement.
    const existing = steps.find(
      (step) => step.from === from && step.against === against,
    );
    if (existing) existing.amount = add(existing.amount, applied);
    else steps.push({ from, against, amount: applied });
  };

  // IGST against IGST is not a choice; the rest of the pool is.
  apply("igst", "igst");
  const directed = { cgst: owed.cgst, sgst: owed.sgst };
  directIgst(owed, available);
  const igstToCgst = subtract(directed.cgst, owed.cgst);
  const igstToSgst = subtract(directed.sgst, owed.sgst);
  if (compare(igstToCgst, 0) > 0)
    steps.push({ from: "igst", against: "cgst", amount: igstToCgst });
  if (compare(igstToSgst, 0) > 0)
    steps.push({ from: "igst", against: "sgst", amount: igstToSgst });

  for (const { from, against } of ORDER) {
    if (from === "igst" && against === "igst") continue;
    apply(from, against);
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
