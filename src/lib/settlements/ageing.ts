import {
  type Decimal,
  add,
  compare,
  money,
  subtract,
  type MoneyInput,
} from "@/lib/money";

/**
 * Ageing.
 *
 * Pure: given documents with a due date and an outstanding amount, work out how
 * overdue each is and total them into the buckets a retailer chases by.
 *
 * The buckets are counted from the *due* date, not the document date. An
 * invoice on 30 days' credit raised three weeks ago is not overdue at all, and
 * a system that files it under "21 days" invites someone to chase a customer
 * who has done nothing wrong.
 */

export type AgeingBucketKey =
  "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

export const AGEING_BUCKETS: ReadonlyArray<{
  key: AgeingBucketKey;
  label: string;
  /** Inclusive lower bound in days overdue. */
  from: number;
  /** Inclusive upper bound, or null for open-ended. */
  to: number | null;
}> = [
  { key: "current", label: "Not yet due", from: -Infinity, to: 0 },
  { key: "d1_30", label: "1–30 days", from: 1, to: 30 },
  { key: "d31_60", label: "31–60 days", from: 31, to: 60 },
  { key: "d61_90", label: "61–90 days", from: 61, to: 90 },
  { key: "d90_plus", label: "Over 90 days", from: 91, to: null },
];

const DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days a document is past its due date. Zero or negative means not due.
 *
 * Both dates are truncated to the day: an invoice due today is not one second
 * overdue at 4pm, and telling someone it is would be wrong in a way they would
 * notice.
 */
export function daysOverdue(dueDate: Date, asOf: Date): number {
  const due = Date.UTC(
    dueDate.getUTCFullYear(),
    dueDate.getUTCMonth(),
    dueDate.getUTCDate(),
  );
  const now = Date.UTC(
    asOf.getUTCFullYear(),
    asOf.getUTCMonth(),
    asOf.getUTCDate(),
  );
  return Math.round((now - due) / DAY);
}

export function bucketFor(days: number): AgeingBucketKey {
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export type AgeingDocument = {
  /** Falls back to the document date when no credit terms were agreed. */
  dueDate: Date;
  outstanding: MoneyInput;
};

export type AgeingSummary = {
  total: Decimal;
  overdue: Decimal;
  buckets: Record<AgeingBucketKey, Decimal>;
  /** The oldest debt in days, or null when nothing is overdue. */
  oldestOverdueDays: number | null;
};

export function summariseAgeing(
  documents: readonly AgeingDocument[],
  asOf: Date,
): AgeingSummary {
  const buckets: Record<AgeingBucketKey, Decimal> = {
    current: money(0),
    d1_30: money(0),
    d31_60: money(0),
    d61_90: money(0),
    d90_plus: money(0),
  };

  let total = money(0);
  let overdue = money(0);
  let oldest: number | null = null;

  for (const document of documents) {
    const amount = money(document.outstanding);
    // A settled or over-settled document is not outstanding; including it would
    // net someone else's debt away and understate what is owed.
    if (compare(amount, 0) <= 0) continue;

    const days = daysOverdue(document.dueDate, asOf);
    const key = bucketFor(days);

    buckets[key] = add(buckets[key], amount);
    total = add(total, amount);

    if (days > 0) {
      overdue = add(overdue, amount);
      if (oldest === null || days > oldest) oldest = days;
    }
  }

  return { total, overdue, buckets, oldestOverdueDays: oldest };
}

/**
 * Spreads a settlement across documents, oldest first.
 *
 * This is what "settle the oldest first" means in practice, and it is the
 * default every accountant expects: money received goes against the debt that
 * has been outstanding longest, not against whatever is convenient.
 *
 * Returns what each document should take. Anything left over is an advance —
 * the caller decides what to do with it.
 */
export function allocateOldestFirst(
  amount: MoneyInput,
  documents: ReadonlyArray<{
    id: string;
    outstanding: MoneyInput;
    dueDate: Date;
  }>,
): {
  allocations: Array<{ id: string; amount: Decimal }>;
  unallocated: Decimal;
} {
  let remaining = money(amount);
  const allocations: Array<{ id: string; amount: Decimal }> = [];

  const ordered = [...documents].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
  );

  for (const document of ordered) {
    if (compare(remaining, 0) <= 0) break;

    const outstanding = money(document.outstanding);
    if (compare(outstanding, 0) <= 0) continue;

    const take = compare(outstanding, remaining) <= 0 ? outstanding : remaining;
    allocations.push({ id: document.id, amount: take });
    remaining = subtract(remaining, take);
  }

  return { allocations, unallocated: remaining };
}
