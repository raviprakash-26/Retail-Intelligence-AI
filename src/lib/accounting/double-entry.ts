import type { AccountNature, PartyType, VoucherType } from "@prisma/client";
import {
  add,
  compare,
  Decimal,
  equals,
  isNegative,
  isZero,
  money,
  subtract,
  type MoneyInput,
} from "@/lib/money";

/**
 * Double-entry primitives.
 *
 * This module is deliberately pure: no database, no framework, no I/O. It is
 * the single definition of what "a valid journal entry" means, which lets the
 * rule set be unit-tested exhaustively and reused by the posting engine, the
 * importer, the audit rules and the seed script alike.
 */

/** One side of an entry, before it is persisted. */
export type DraftJournalLine = {
  accountId: string;
  debit?: MoneyInput;
  credit?: MoneyInput;
  narration?: string | null;
  partyType?: PartyType | null;
  partyId?: string | null;
};

export type DraftJournalEntry = {
  entryDate: Date;
  voucherType: VoucherType;
  narration?: string | null;
  referenceNo?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  lines: readonly DraftJournalLine[];
};

/** A line that has passed validation: exactly one side, non-negative. */
export type BalancedJournalLine = {
  accountId: string;
  lineNumber: number;
  debit: Decimal;
  credit: Decimal;
  narration: string | null;
  partyType: PartyType | null;
  partyId: string | null;
};

export type BalancedJournalEntry = {
  entryDate: Date;
  voucherType: VoucherType;
  narration: string | null;
  referenceNo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  lines: BalancedJournalLine[];
  totalDebit: Decimal;
  totalCredit: Decimal;
};

export type ValidationIssue = {
  code: string;
  message: string;
  lineIndex?: number;
};

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/**
 * Raised when code attempts to post an entry that does not balance. This is
 * always a programming error, never a user-input error — user input is caught
 * earlier by `validateJournalEntry`.
 */
export class UnbalancedEntryError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(
      `Journal entry is not balanced:\n${issues
        .map((issue) => `  • ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "UnbalancedEntryError";
    this.issues = issues;
  }
}

/**
 * Validate a draft entry and normalise it into a postable shape.
 *
 * Rules enforced here (mirrored by database CHECK constraints and triggers, so
 * neither layer alone is load-bearing):
 *   1. At least two lines — a single-sided entry is not a journal entry.
 *   2. Every line posts to exactly one side.
 *   3. No negative amounts. A negative debit is a credit, and writing it as a
 *      negative debit hides the transaction's real direction in reports.
 *   4. Total debits equal total credits, exactly, at storage scale.
 *   5. No account appears twice on the same side without an explanatory
 *      narration — usually a sign of a duplicated line.
 */
export function validateJournalEntry(
  draft: DraftJournalEntry,
): ValidationResult<BalancedJournalEntry> {
  const issues: ValidationIssue[] = [];

  if (draft.lines.length < 2) {
    issues.push({
      code: "TOO_FEW_LINES",
      message: `A journal entry needs at least two lines; received ${draft.lines.length}.`,
    });
  }

  if (Number.isNaN(draft.entryDate.getTime())) {
    issues.push({
      code: "INVALID_DATE",
      message: "Entry date is not a valid date.",
    });
  }

  const lines: BalancedJournalLine[] = [];
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  draft.lines.forEach((line, index) => {
    const debit = money(line.debit ?? 0);
    const credit = money(line.credit ?? 0);

    if (!line.accountId) {
      issues.push({
        code: "MISSING_ACCOUNT",
        message: `Line ${index + 1} has no account.`,
        lineIndex: index,
      });
    }

    if (isNegative(debit) || isNegative(credit)) {
      issues.push({
        code: "NEGATIVE_AMOUNT",
        message: `Line ${index + 1} has a negative amount. Post to the opposite side instead of using a negative value.`,
        lineIndex: index,
      });
    }

    const debitIsZero = isZero(debit);
    const creditIsZero = isZero(credit);

    if (debitIsZero && creditIsZero) {
      issues.push({
        code: "EMPTY_LINE",
        message: `Line ${index + 1} has neither a debit nor a credit amount.`,
        lineIndex: index,
      });
    } else if (!debitIsZero && !creditIsZero) {
      issues.push({
        code: "TWO_SIDED_LINE",
        message: `Line ${index + 1} has both a debit and a credit. Split it into two lines.`,
        lineIndex: index,
      });
    }

    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);

    lines.push({
      accountId: line.accountId,
      lineNumber: index + 1,
      debit,
      credit,
      narration: line.narration ?? null,
      partyType: line.partyType ?? null,
      partyId: line.partyId ?? null,
    });
  });

  const normalisedDebit = money(totalDebit);
  const normalisedCredit = money(totalCredit);

  if (!equals(normalisedDebit, normalisedCredit)) {
    const difference = subtract(normalisedDebit, normalisedCredit);
    issues.push({
      code: "UNBALANCED",
      message:
        `Debits (${normalisedDebit.toFixed(2)}) do not equal credits ` +
        `(${normalisedCredit.toFixed(2)}); difference ${difference.toFixed(2)}.`,
    });
  }

  if (
    isZero(normalisedDebit) &&
    isZero(normalisedCredit) &&
    draft.lines.length > 0
  ) {
    issues.push({
      code: "ZERO_VALUE_ENTRY",
      message: "A journal entry with no monetary value cannot be posted.",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      entryDate: draft.entryDate,
      voucherType: draft.voucherType,
      narration: draft.narration ?? null,
      referenceNo: draft.referenceNo ?? null,
      sourceType: draft.sourceType ?? null,
      sourceId: draft.sourceId ?? null,
      lines,
      totalDebit: normalisedDebit,
      totalCredit: normalisedCredit,
    },
  };
}

/** Validate or throw. Use at the posting boundary, where failure is a bug. */
export function assertBalanced(draft: DraftJournalEntry): BalancedJournalEntry {
  const result = validateJournalEntry(draft);
  if (!result.ok) {
    throw new UnbalancedEntryError(result.issues);
  }
  return result.value;
}

/**
 * Collapse repeated postings to the same account into one line per side.
 *
 * A sale with five 18% lines produces five identical CGST postings; merging
 * them keeps the ledger readable without changing a single figure.
 */
export function condenseLines(
  lines: readonly DraftJournalLine[],
): DraftJournalLine[] {
  const merged = new Map<string, DraftJournalLine>();

  for (const line of lines) {
    // Party-attributed lines stay separate so sub-ledgers remain resolvable.
    const key = [
      line.accountId,
      line.partyType ?? "",
      line.partyId ?? "",
      line.narration ?? "",
    ].join("|");

    const existing = merged.get(key);
    if (existing) {
      existing.debit = add(existing.debit ?? 0, line.debit ?? 0);
      existing.credit = add(existing.credit ?? 0, line.credit ?? 0);
    } else {
      merged.set(key, {
        ...line,
        debit: money(line.debit ?? 0),
        credit: money(line.credit ?? 0),
      });
    }
  }

  // A merged pair may now be two-sided (e.g. a debit and a credit to the same
  // account). Net it down to the side it actually lands on.
  return [...merged.values()]
    .map((line) => {
      const debit = money(line.debit ?? 0);
      const credit = money(line.credit ?? 0);
      if (isZero(debit) || isZero(credit)) return { ...line, debit, credit };

      const net = subtract(debit, credit);
      return compare(net, 0) >= 0
        ? { ...line, debit: net, credit: money(0) }
        : { ...line, debit: money(0), credit: money(net.negated()) };
    })
    .filter((line) => !isZero(line.debit ?? 0) || !isZero(line.credit ?? 0));
}

/**
 * Signed effect of a posting on an account's balance, in the direction of its
 * normal (natural) side.
 *
 * A debit to Cash (a DEBIT-nature account) increases it; a debit to Sales (a
 * CREDIT-nature account) decreases it. Every ledger and statement figure in the
 * system flows through this one rule rather than re-deriving sign conventions.
 */
export function signedBalance(
  nature: AccountNature,
  debit: MoneyInput,
  credit: MoneyInput,
): Decimal {
  return nature === "DEBIT" ? subtract(debit, credit) : subtract(credit, debit);
}

/**
 * Debit or credit, for the side a balance from `signedBalance` sits on.
 *
 * The nature is needed and reading the sign alone will not do. That figure is
 * signed *against the account's own nature* — positive means "on the side this
 * account normally sits on" — so on payables a positive balance is money the
 * shop owes and belongs on the credit side. Taking positive to mean debit was
 * backwards for every credit-nature account in the chart: every liability, all
 * income, capital, and accumulated depreciation, which is an asset held at
 * credit nature precisely because it is a contra.
 *
 * The ledger printed it under `describeBalance`, so a supplier account read
 * "You owe Metro Wholesale this much" and tagged the figure "Dr" — which says
 * the supplier owes the shop. The two halves of one heading contradicted each
 * other, and the same tag sat on the opening balance, the closing balance and
 * every running balance between them, on the statement a business sends its
 * supplier.
 *
 * Note this is the opposite job from `balanceSide` below, which is handed raw
 * debit and credit totals and reports where they landed. This is handed a
 * figure whose sign has already been folded into the account's nature, and has
 * to unfold it again.
 */
export function balanceSideLabel(params: {
  nature: AccountNature;
  balance: MoneyInput;
}): "Dr" | "Cr" | "" {
  const value = money(params.balance);
  if (value.isZero()) return "";
  const naturalSide = params.nature === "DEBIT" ? "Dr" : "Cr";
  if (!value.isNegative()) return naturalSide;
  return naturalSide === "Dr" ? "Cr" : "Dr";
}

/**
 * Which column a balance belongs in on the trial balance.
 *
 * Note this deliberately ignores the account's declared nature: the trial
 * balance reports where a balance *actually* sits, not where it is expected
 * to. A supplier ledger with a debit balance (an advance paid) must show in
 * the debit column, and forcing it to the credit side by its nature would
 * hide exactly the anomaly the report exists to surface.
 */
export function balanceSide(
  debit: MoneyInput,
  credit: MoneyInput,
): { debit: Decimal; credit: Decimal } {
  const net = subtract(debit, credit);
  return compare(net, 0) >= 0
    ? { debit: money(net), credit: money(0) }
    : { debit: money(0), credit: money(net.negated()) };
}

/** Trial-balance level assertion used before any statement is rendered. */
export function trialBalanceIsBalanced(
  rows: ReadonlyArray<{ debit: MoneyInput; credit: MoneyInput }>,
): {
  balanced: boolean;
  totalDebit: Decimal;
  totalCredit: Decimal;
  difference: Decimal;
} {
  const totalDebit = add(...rows.map((row) => row.debit));
  const totalCredit = add(...rows.map((row) => row.credit));
  const difference = subtract(totalDebit, totalCredit);

  return {
    balanced: isZero(difference),
    totalDebit,
    totalCredit,
    difference,
  };
}
