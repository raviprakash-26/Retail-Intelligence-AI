import { Decimal, equals, toDecimal } from "@/lib/money";
import type { StatementDirection } from "./statement-parser";

/**
 * Suggesting which statement line is which book entry.
 *
 * Two rules govern everything here.
 *
 * **Amounts must be equal.** Not close, not within a tolerance — equal. A
 * reconciliation exists to find the difference between what the bank says and
 * what the books say, so a matcher that pairs ₹4,500 with ₹4,505 has destroyed
 * the only signal the whole exercise produces.
 *
 * **A suggestion is not a decision.** Nothing here writes anything. Every pair
 * carries the reason it was suggested, and a person confirms it. The date
 * window that makes a cheque match is the same window that would wrongly pair
 * two identical rent payments a week apart, and only somebody who knows the
 * business can tell those apart.
 *
 * This is arithmetic and comparison, deliberately. Handing reconciliation to a
 * model would mean a plausible-looking pairing nobody can reproduce, in the one
 * place where being confidently wrong costs a business real money.
 */

export type MatchConfidence = "exact" | "likely" | "possible";

export type StatementSide = {
  id: string;
  date: Date;
  amount: Decimal | string;
  direction: StatementDirection;
  description: string;
  referenceNo?: string | null;
};

export type BookSide = {
  id: string;
  date: Date;
  /** Movement on the bank account itself: debit is money in. */
  amount: Decimal | string;
  direction: StatementDirection;
  narration?: string | null;
  referenceNo?: string | null;
};

export type SuggestedMatch = {
  statementId: string;
  bookId: string;
  confidence: MatchConfidence;
  /** Shown to the person confirming, in their words rather than a score. */
  reason: string;
  dayGap: number;
};

/** Same amount and reference, within this many days. */
const REFERENCE_WINDOW_DAYS = 40;
/** Same amount, no reference to go on. */
const LIKELY_WINDOW_DAYS = 3;
const POSSIBLE_WINDOW_DAYS = 10;

const DAY_MS = 86_400_000;

function daysApart(left: Date, right: Date): number {
  return Math.round(
    Math.abs(
      Date.UTC(left.getUTCFullYear(), left.getUTCMonth(), left.getUTCDate()) -
        Date.UTC(
          right.getUTCFullYear(),
          right.getUTCMonth(),
          right.getUTCDate(),
        ),
    ) / DAY_MS,
  );
}

/**
 * Reference numbers are compared on their digits.
 *
 * A cheque recorded as "234567" and printed on the statement as "CHQ 234567" or
 * "000234567" is the same cheque, and a string comparison says it is not. Short
 * numbers are ignored entirely: a two-digit "12" would match half the file.
 */
function referenceKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 4 ? digits : null;
}

function amountOf(value: Decimal | string): Decimal {
  return toDecimal(value);
}

type Candidate = {
  statementIndex: number;
  bookIndex: number;
  confidence: MatchConfidence;
  reason: string;
  dayGap: number;
};

const RANK: Record<MatchConfidence, number> = {
  exact: 0,
  likely: 1,
  possible: 2,
};

/**
 * Pairs statement lines with book entries, one to one.
 *
 * Ambiguity is resolved by taking the strongest evidence first and never
 * reusing either side — so where a business paid the same rent twice in a
 * fortnight, the earlier statement line takes the earlier book entry rather
 * than both competing for whichever was found first.
 *
 * What this deliberately does not do is chase combinations. Three ₹500 book
 * entries summing to one ₹1,500 deposit is a real thing that happens, and
 * searching for subsets that add up would produce coincidences at a rate no
 * person could audit. Those are left unmatched for somebody to look at.
 */
export function suggestMatches(
  statement: readonly StatementSide[],
  book: readonly BookSide[],
): SuggestedMatch[] {
  const candidates: Candidate[] = [];

  for (
    let statementIndex = 0;
    statementIndex < statement.length;
    statementIndex += 1
  ) {
    const line = statement[statementIndex]!;
    const lineAmount = amountOf(line.amount);
    const lineReference = referenceKey(line.referenceNo);

    for (let bookIndex = 0; bookIndex < book.length; bookIndex += 1) {
      const entry = book[bookIndex]!;

      // Direction first: a payment out can never be a receipt in, whatever the
      // amount says.
      if (entry.direction !== line.direction) continue;
      if (!equals(amountOf(entry.amount), lineAmount)) continue;

      const gap = daysApart(line.date, entry.date);
      const entryReference =
        referenceKey(entry.referenceNo) ??
        referenceKey(extractReference(entry.narration));

      if (
        lineReference !== null &&
        entryReference !== null &&
        lineReference === entryReference &&
        gap <= REFERENCE_WINDOW_DAYS
      ) {
        candidates.push({
          statementIndex,
          bookIndex,
          confidence: "exact",
          reason: `Same amount and reference ${lineReference}`,
          dayGap: gap,
        });
        continue;
      }

      if (gap <= LIKELY_WINDOW_DAYS) {
        candidates.push({
          statementIndex,
          bookIndex,
          confidence: "likely",
          reason:
            gap === 0
              ? "Same amount, same date"
              : `Same amount, ${gap} day${gap === 1 ? "" : "s"} apart`,
          dayGap: gap,
        });
        continue;
      }

      if (gap <= POSSIBLE_WINDOW_DAYS) {
        candidates.push({
          statementIndex,
          bookIndex,
          confidence: "possible",
          reason: `Same amount, ${gap} days apart — check before accepting`,
          dayGap: gap,
        });
      }
    }
  }

  // Strongest first, then closest in time, then oldest statement line. The last
  // tiebreak is what makes the result stable: without it two equally good pairs
  // would be chosen by whatever order the database happened to return.
  candidates.sort(
    (left, right) =>
      RANK[left.confidence] - RANK[right.confidence] ||
      left.dayGap - right.dayGap ||
      left.statementIndex - right.statementIndex ||
      left.bookIndex - right.bookIndex,
  );

  const usedStatement = new Set<number>();
  const usedBook = new Set<number>();
  const matches: SuggestedMatch[] = [];

  for (const candidate of candidates) {
    if (usedStatement.has(candidate.statementIndex)) continue;
    if (usedBook.has(candidate.bookIndex)) continue;
    usedStatement.add(candidate.statementIndex);
    usedBook.add(candidate.bookIndex);
    matches.push({
      statementId: statement[candidate.statementIndex]!.id,
      bookId: book[candidate.bookIndex]!.id,
      confidence: candidate.confidence,
      reason: candidate.reason,
      dayGap: candidate.dayGap,
    });
  }

  return matches;
}

/**
 * Pulls a cheque or transfer number out of free text.
 *
 * Journal narrations are written by people: "Cheque 234567 to Sharma Traders".
 * The number is worth finding because it is the one piece of evidence that
 * turns a guess into a match, but only long runs are considered — a date in the
 * narration must not become a reference.
 */
export function extractReference(
  narration: string | null | undefined,
): string | null {
  if (!narration) return null;
  const match = /\b(\d{6,})\b/.exec(narration);
  return match ? match[1]! : null;
}

/**
 * The classic bank reconciliation statement, as an identity.
 *
 * Balance per books and balance per statement differ by exactly the items that
 * appear on one side and not the other: deposits recorded but not yet credited,
 * and cheques issued but not yet presented. If that does not hold, something is
 * wrong with this module rather than with the business — so it is computed both
 * ways and the difference between the two is reported rather than hidden.
 */
export type ReconciliationDifference = {
  /** Closing balance the books show for the bank account. */
  perBooks: Decimal;
  /** Opening balance plus every imported statement movement. */
  perStatement: Decimal;
  /** Book movements not yet on the statement, netted (in minus out). */
  unpresentedNet: Decimal;
  /** Statement movements not yet in the books, netted. */
  unrecordedNet: Decimal;
  /**
   * What is left after both sets of timing differences are accounted for.
   *
   * Zero means reconciled. Anything else is a real, unexplained gap — and the
   * page says so instead of rounding it away.
   */
  unexplained: Decimal;
};

export function reconciliationDifference(input: {
  perBooks: Decimal | string;
  perStatement: Decimal | string;
  unmatchedBook: readonly {
    amount: Decimal | string;
    direction: StatementDirection;
  }[];
  unmatchedStatement: readonly {
    amount: Decimal | string;
    direction: StatementDirection;
  }[];
}): ReconciliationDifference {
  const perBooks = amountOf(input.perBooks);
  const perStatement = amountOf(input.perStatement);

  const net = (
    rows: readonly {
      amount: Decimal | string;
      direction: StatementDirection;
    }[],
  ) =>
    rows.reduce(
      (total, row) =>
        row.direction === "IN"
          ? total.plus(amountOf(row.amount))
          : total.minus(amountOf(row.amount)),
      new Decimal(0),
    );

  const unpresentedNet = net(input.unmatchedBook);
  const unrecordedNet = net(input.unmatchedStatement);

  // perBooks - unpresented should equal perStatement - unrecorded: both sides
  // stripped back to the movements they agree on.
  const unexplained = perBooks
    .minus(unpresentedNet)
    .minus(perStatement.minus(unrecordedNet));

  return {
    perBooks,
    perStatement,
    unpresentedNet,
    unrecordedNet,
    unexplained,
  };
}
