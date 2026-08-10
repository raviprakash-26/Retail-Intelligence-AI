import Decimal from "decimal.js";

/**
 * Monetary arithmetic.
 *
 * Every amount in this system is an exact decimal, never an IEEE-754 float.
 * `0.1 + 0.2 !== 0.3` is a rounding curiosity in most software and a
 * reconciliation failure in an accounting system: a trial balance that is off
 * by 0.0000000000000004 does not balance.
 *
 * Conventions
 *  - Storage: PostgreSQL `DECIMAL(18,4)`.
 *  - Working precision: 4 decimal places, so per-unit rates and tax splits keep
 *    their fractions until the document total is rounded.
 *  - Presentation: 2 decimal places, half-up — the rounding convention Indian
 *    invoices and GST returns use.
 */

/**
 * Precision high enough that intermediate products/quotients never lose
 * significance before the explicit rounding step.
 */
Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

/** Number of decimals retained in storage and in intermediate calculations. */
export const CALCULATION_SCALE = 4;

/** Number of decimals shown to users and used on printed documents. */
export const PRESENTATION_SCALE = 2;

/**
 * A decimal from *some* copy of decimal.js.
 *
 * Prisma bundles its own build of the library, so a `Decimal` returned by the
 * client is not an `instanceof` the `Decimal` imported here even though it is
 * the same type of value. Matching structurally is what lets a figure read
 * straight out of the database flow into these helpers.
 */
export type DecimalLike = {
  toFixed(decimalPlaces?: number): string;
  toString(): string;
};

/**
 * Anything that can be interpreted as an exact decimal amount. Prisma returns
 * `Decimal` instances, forms produce strings, and constants are numbers.
 */
export type MoneyInput =
  Decimal | DecimalLike | string | number | null | undefined;

export { Decimal };

/** True for a decimal.js instance from any build of the library. */
function isDecimalLike(value: object): value is DecimalLike {
  return typeof (value as DecimalLike).toFixed === "function";
}

/**
 * Coerce any supported representation into a Decimal.
 *
 * Numbers are stringified first: `new Decimal(0.1)` captures the float's
 * binary error, while `new Decimal("0.1")` is exact.
 */
export function toDecimal(value: MoneyInput): Decimal {
  if (value === null || value === undefined || value === "") {
    return new Decimal(0);
  }
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `Cannot convert non-finite number to money: ${value}`,
      );
    }
    return new Decimal(value.toString());
  }

  // Prisma's Decimal lands here: same value, different class identity.
  // `toFixed` preserves every digit, where `toString` can switch to
  // exponential notation for very large or very small magnitudes.
  if (typeof value === "object") {
    if (!isDecimalLike(value)) {
      throw new TypeError("Cannot convert this value to a monetary amount");
    }
    try {
      return new Decimal(value.toFixed());
    } catch {
      throw new TypeError("Cannot convert this value to a monetary amount");
    }
  }

  const normalised = value.trim().replace(/,/g, "");
  if (normalised === "" || normalised === "-") {
    return new Decimal(0);
  }
  try {
    return new Decimal(normalised);
  } catch {
    throw new TypeError(`Cannot convert "${value}" to a monetary amount`);
  }
}

/** Round to storage scale. Use before persisting or comparing. */
export function money(value: MoneyInput): Decimal {
  return toDecimal(value).toDecimalPlaces(
    CALCULATION_SCALE,
    Decimal.ROUND_HALF_UP,
  );
}

/** Round to the 2-decimal presentation scale. */
export function round2(value: MoneyInput): Decimal {
  return toDecimal(value).toDecimalPlaces(
    PRESENTATION_SCALE,
    Decimal.ROUND_HALF_UP,
  );
}

export function add(...values: MoneyInput[]): Decimal {
  return money(
    values.reduce<Decimal>(
      (sum, value) => sum.plus(toDecimal(value)),
      new Decimal(0),
    ),
  );
}

export function subtract(
  minuend: MoneyInput,
  ...values: MoneyInput[]
): Decimal {
  return money(
    values.reduce<Decimal>(
      (result, value) => result.minus(toDecimal(value)),
      toDecimal(minuend),
    ),
  );
}

export function multiply(...values: MoneyInput[]): Decimal {
  return money(
    values.reduce<Decimal>(
      (product, value) => product.times(toDecimal(value)),
      new Decimal(1),
    ),
  );
}

export function divide(dividend: MoneyInput, divisor: MoneyInput): Decimal {
  const d = toDecimal(divisor);
  if (d.isZero()) {
    throw new RangeError("Division by zero in monetary calculation");
  }
  return money(toDecimal(dividend).dividedBy(d));
}

/** `value` × `percent`% — e.g. `percentOf(1000, 18)` is 180. */
export function percentOf(value: MoneyInput, percent: MoneyInput): Decimal {
  return money(toDecimal(value).times(toDecimal(percent)).dividedBy(100));
}

/**
 * Extract the tax component from a tax-inclusive amount.
 *
 * `taxFromInclusive(118, 18)` is 18 — not 21.24, which is what applying the
 * rate directly to an inclusive figure would wrongly give.
 */
export function taxFromInclusive(
  inclusiveAmount: MoneyInput,
  ratePercent: MoneyInput,
): Decimal {
  const rate = toDecimal(ratePercent);
  const divisor = new Decimal(100).plus(rate);
  if (divisor.isZero()) {
    return new Decimal(0);
  }
  return money(toDecimal(inclusiveAmount).times(rate).dividedBy(divisor));
}

/** The net (pre-tax) portion of a tax-inclusive amount. */
export function netFromInclusive(
  inclusiveAmount: MoneyInput,
  ratePercent: MoneyInput,
): Decimal {
  return subtract(
    inclusiveAmount,
    taxFromInclusive(inclusiveAmount, ratePercent),
  );
}

export function isZero(value: MoneyInput): boolean {
  return money(value).isZero();
}

export function isNegative(value: MoneyInput): boolean {
  return money(value).isNegative() && !money(value).isZero();
}

export function isPositive(value: MoneyInput): boolean {
  return money(value).greaterThan(0);
}

/** Exact equality at storage scale. Never compare amounts with `===`. */
export function equals(a: MoneyInput, b: MoneyInput): boolean {
  return money(a).equals(money(b));
}

export function compare(a: MoneyInput, b: MoneyInput): -1 | 0 | 1 {
  return money(a).comparedTo(money(b)) as -1 | 0 | 1;
}

export function max(...values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>(
    (best, value) => (toDecimal(value).greaterThan(best) ? money(value) : best),
    money(values[0] ?? 0),
  );
}

export function min(...values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>(
    (best, value) => (toDecimal(value).lessThan(best) ? money(value) : best),
    money(values[0] ?? 0),
  );
}

export function abs(value: MoneyInput): Decimal {
  return money(toDecimal(value).abs());
}

export function negate(value: MoneyInput): Decimal {
  return money(toDecimal(value).negated());
}

export function sum(values: readonly MoneyInput[]): Decimal {
  return add(...values);
}

export function sumBy<T>(
  items: readonly T[],
  selector: (item: T) => MoneyInput,
): Decimal {
  return add(...items.map(selector));
}

/**
 * Difference between an amount and its nearest rupee, as posted to a round-off
 * ledger. Positive means the invoice was rounded up.
 */
export function roundOffDifference(value: MoneyInput): Decimal {
  const exact = money(value);
  return subtract(exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP), exact);
}

/**
 * Split an amount into `parts` shares that sum back to exactly the original.
 *
 * Naive division leaves a remainder — ₹100 across 3 lines gives 33.33 × 3 =
 * 99.99, and the missing paisa would surface as an unbalanced journal entry.
 * The remainder is distributed one minor unit at a time across the leading
 * shares.
 */
export function allocate(value: MoneyInput, parts: number): Decimal[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError("allocate() requires a positive integer part count");
  }

  const total = money(value);
  const unit = new Decimal(10).pow(-CALCULATION_SCALE);
  const baseShare = total
    .dividedBy(parts)
    .toDecimalPlaces(CALCULATION_SCALE, Decimal.ROUND_DOWN);

  const shares = Array.from({ length: parts }, () => baseShare);
  let remainder = total.minus(baseShare.times(parts));

  let index = 0;
  const step = remainder.isNegative() ? unit.negated() : unit;
  while (!remainder.isZero() && index < parts * 2) {
    shares[index % parts] = (shares[index % parts] ?? baseShare).plus(step);
    remainder = remainder.minus(step);
    index += 1;
  }

  return shares;
}

/**
 * Distribute an amount across weights, preserving the exact total.
 * Used for apportioning invoice-level discounts and freight across lines.
 */
export function allocateByWeight(
  value: MoneyInput,
  weights: readonly MoneyInput[],
): Decimal[] {
  const total = money(value);
  const totalWeight = add(...weights);

  if (totalWeight.isZero()) {
    return allocate(total, Math.max(weights.length, 1)).slice(
      0,
      weights.length,
    );
  }

  const shares = weights.map((weight) =>
    total
      .times(toDecimal(weight))
      .dividedBy(totalWeight)
      .toDecimalPlaces(CALCULATION_SCALE, Decimal.ROUND_DOWN),
  );

  const distributed = shares.reduce<Decimal>(
    (acc, share) => acc.plus(share),
    new Decimal(0),
  );
  const remainder = total.minus(distributed);

  if (!remainder.isZero() && shares.length > 0) {
    const lastIndex = shares.length - 1;
    shares[lastIndex] = (shares[lastIndex] ?? new Decimal(0)).plus(remainder);
  }

  return shares;
}

/** Serialise for storage or transport. Always a fixed-scale decimal string. */
export function toStorageString(value: MoneyInput): string {
  return money(value).toFixed(CALCULATION_SCALE);
}

/**
 * Convert to a JS number. Only for charting and statistics — never for a value
 * that will be written back to the database or shown as an authoritative
 * figure.
 */
export function toNumber(value: MoneyInput): number {
  return money(value).toNumber();
}
