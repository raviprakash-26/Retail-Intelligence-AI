/**
 * What the auditor looks for, and what it is careful not to say.
 *
 * **Nothing here accuses anybody of anything.** Every rule describes something
 * the books show, and every rule carries the ordinary explanations for it —
 * because almost every one of these has an innocent cause that is more likely
 * than a dishonest one. A shop where the cash ledger dips below zero has
 * usually recorded a payment before the receipt that funded it, not been
 * robbed. Saying otherwise about a family business, on the strength of a
 * database query, would be indefensible.
 *
 * The vocabulary is enforced rather than trusted: a test fails if the word
 * "fraud", "theft", "stolen" or any of their neighbours appears in a rule's
 * title, description, explanation or recommendation. An auditor that can only
 * describe is an auditor that cannot accuse.
 *
 * **No model produces these.** Findings come from deterministic checks over
 * posted entries, the score is arithmetic on their severities, and a later
 * phase may narrate them in words without being able to add, remove or reweigh
 * one.
 */

export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const RULE_KEYS = [
  "LEDGER_OUT_OF_BALANCE",
  "NEGATIVE_CASH_BALANCE",
  "NEGATIVE_STOCK",
  "STOCK_LEDGER_MISMATCH",
  "GST_REGISTER_MISMATCH",
  "CASH_PAYMENT_OVER_LIMIT",
  "DUPLICATE_INVOICE_SAME_DAY",
  "SALE_BELOW_COST",
  "BACKDATED_ENTRY",
  "HIGH_VOID_RATE",
  "LONG_OVERDUE_RECEIVABLE",
] as const;

export type RuleKey = (typeof RULE_KEYS)[number];

export type Rule = {
  key: RuleKey;
  severity: Severity;
  title: string;
  /** What the books show. A fact, not a conclusion. */
  description: string;
  /**
   * The ordinary reasons this happens. Present on every rule, and shown with
   * every finding, because the innocent explanation is usually the true one.
   */
  ordinaryExplanations: readonly string[];
  /** What to do about it — always a check to make, never an allegation. */
  recommendation: string;
};

export const RULES: Record<RuleKey, Rule> = {
  LEDGER_OUT_OF_BALANCE: {
    key: "LEDGER_OUT_OF_BALANCE",
    severity: "CRITICAL",
    title: "The ledger does not balance",
    description:
      "Total debits and total credits are not equal. Every report built on the ledger is unreliable until this is explained.",
    ordinaryExplanations: [
      "An entry was written directly to the database rather than through the application.",
      "A migration or import left a half-posted entry behind.",
    ],
    recommendation:
      "Open the trial balance and find the date the difference appears. Nothing else on this list matters until this does not.",
  },

  NEGATIVE_CASH_BALANCE: {
    key: "NEGATIVE_CASH_BALANCE",
    severity: "HIGH",
    title: "Cash in hand went below zero",
    description:
      "On at least one date the cash account shows less than nothing. A drawer cannot hold negative money, so the records and the day do not agree.",
    ordinaryExplanations: [
      "A payment was recorded before the receipt that funded it, so the order on the day is wrong rather than the amounts.",
      "Money taken over the counter was banked and recorded, but the sale behind it was entered later.",
      "An opening cash balance was never entered when the books were started.",
    ],
    recommendation:
      "Open the cash ledger at the first date it goes negative and check what was recorded that day and what was recorded late.",
  },

  NEGATIVE_STOCK: {
    key: "NEGATIVE_STOCK",
    severity: "HIGH",
    title: "A product shows less than no stock",
    description:
      "More of an item has been sold than was ever recorded as bought. The shelves cannot hold a negative quantity.",
    ordinaryExplanations: [
      "A purchase was made and sold from before the bill was entered.",
      "Opening stock was never recorded for a product that was already on the shelves.",
      "A unit of measure differs between how the item is bought and how it is sold.",
    ],
    recommendation:
      "Open the stock card for the product and find the first movement that takes it below nil.",
  },

  STOCK_LEDGER_MISMATCH: {
    key: "STOCK_LEDGER_MISMATCH",
    severity: "HIGH",
    title: "Stock on the shelves and stock in the books disagree",
    description:
      "The value of stock counted from movements does not equal the balance on the Inventory account. The two are written by different parts of the system and should always agree.",
    ordinaryExplanations: [
      "A stock adjustment was posted without its matching journal entry, or the other way round.",
      "A product's valuation method changed after it had already moved.",
    ],
    recommendation:
      "Open the stock reconciliation, which shows the two figures side by side and where they part company.",
  },

  GST_REGISTER_MISMATCH: {
    key: "GST_REGISTER_MISMATCH",
    severity: "HIGH",
    title: "The tax register and the books disagree",
    description:
      "GST computed from the documents in a period does not equal the movement on the GST accounts. A return prepared from this would rest on figures the books do not support.",
    ordinaryExplanations: [
      "A document was edited in a way that updated one record and not the other.",
      "A journal entry touched a GST account directly without a document behind it.",
    ],
    recommendation:
      "Open the GST working paper for the period; it shows both figures and the difference between them.",
  },

  CASH_PAYMENT_OVER_LIMIT: {
    key: "CASH_PAYMENT_OVER_LIMIT",
    severity: "MEDIUM",
    title: "Cash paid to one person in one day above the section 40A(3) limit",
    description:
      "More than ₹10,000 was paid in cash to the same person on the same date. Where that happens the whole of the day's payment is disallowed for income tax, not just the excess.",
    ordinaryExplanations: [
      "A supplier who does not take bank transfers was paid for a large delivery.",
      "Several small cash payments to one supplier fell on one day without anyone noticing the total.",
    ],
    recommendation:
      "Check the vouchers for the day. Paying by bank transfer, UPI or cheque keeps the deduction; this is worth knowing before the year ends rather than after.",
  },

  DUPLICATE_INVOICE_SAME_DAY: {
    key: "DUPLICATE_INVOICE_SAME_DAY",
    severity: "MEDIUM",
    title: "Two invoices to the same customer, same day, same amount",
    description:
      "Identical amounts were billed twice to one customer on one date. That is unusual enough to be worth a look.",
    ordinaryExplanations: [
      "A customer genuinely bought the same thing twice in a day.",
      "An invoice was raised twice because the first one was thought not to have saved.",
    ],
    recommendation:
      "Open both invoices. If one was raised in error, void it rather than deleting it, so the trail stays intact.",
  },

  SALE_BELOW_COST: {
    key: "SALE_BELOW_COST",
    severity: "MEDIUM",
    title: "Something was sold for less than it cost",
    description:
      "An invoice line went out below the cost recorded against the stock it consumed.",
    ordinaryExplanations: [
      "Old or damaged stock was cleared deliberately.",
      "A promotion or a bulk discount priced an item below cost.",
      "The purchase cost was entered wrongly, so the margin is wrong rather than the price.",
    ],
    recommendation:
      "Check the cost on the product against a recent supplier bill. A wrong cost quietly distorts every margin the product appears in.",
  },

  BACKDATED_ENTRY: {
    key: "BACKDATED_ENTRY",
    severity: "LOW",
    title: "Entries recorded well after the date they carry",
    description:
      "Some documents were entered more than a month after the date written on them.",
    ordinaryExplanations: [
      "A pile of paperwork was caught up on in one sitting, which is how most small shops work.",
      "An accountant entered the quarter's records before a filing deadline.",
    ],
    recommendation:
      "None needed if that is how the books are kept. Entering closer to the day makes every report in between more useful.",
  },

  HIGH_VOID_RATE: {
    key: "HIGH_VOID_RATE",
    severity: "MEDIUM",
    title: "An unusual share of documents were voided",
    description:
      "More than one document in ten was voided in this period. Voiding is the correct way to cancel something, so this is a note about the volume rather than the practice.",
    ordinaryExplanations: [
      "Staff are new to the system and correcting their own mistakes, which is the system working.",
      "A pricing or tax setting was wrong for a while and the affected documents were reissued.",
    ],
    recommendation:
      "Look at the void reasons together. If they say the same thing, the fix is upstream of the voiding.",
  },

  LONG_OVERDUE_RECEIVABLE: {
    key: "LONG_OVERDUE_RECEIVABLE",
    severity: "LOW",
    title: "Money owed for a long time",
    description:
      "Invoices are more than ninety days past their due date and still unpaid.",
    ordinaryExplanations: [
      "A customer with a long-standing arrangement pays on their own rhythm.",
      "The invoice was settled in cash and the receipt was never recorded against it.",
    ],
    recommendation:
      "Check the customer's ledger before chasing. An invoice that was paid but never matched looks exactly like one that was never paid.",
  },
};

export function ruleList(): Rule[] {
  return RULE_KEYS.map((key) => RULES[key]);
}

/**
 * Words an auditor built on database queries has no standing to use.
 *
 * Enforced by a test across every rule's text. A finding says what the books
 * show; what it means about the people involved is not something a query can
 * establish, and a small business owner reading "possible fraud" about their
 * own shop is being told something the software does not know.
 */
export const FORBIDDEN_WORDS = [
  "fraud",
  "fraudulent",
  "theft",
  "thief",
  "stolen",
  "stealing",
  "embezzl",
  "criminal",
  "guilty",
  "dishonest",
  "misappropriat",
  "siphon",
  "cook the books",
  "money launder",
] as const;

/** True where a piece of text makes an accusation the auditor cannot support. */
export function accuses(text: string): boolean {
  const lower = text.toLowerCase();
  return FORBIDDEN_WORDS.some((word) => lower.includes(word));
}

/** How much each severity takes off the score. */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  CRITICAL: 40,
  HIGH: 15,
  MEDIUM: 6,
  LOW: 2,
  INFO: 0,
};

export const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

/**
 * A score out of 100, computed from what was found.
 *
 * Deterministic and reproducible by hand: every finding takes its severity's
 * weight off a starting hundred, and the result is floored at nil. A composite
 * nobody can re-derive is a number to be taken on faith, and an audit score is
 * the last place for that.
 *
 * It is a summary of the findings and nothing more. It is not a measure of
 * honesty, and it is not comparable with another business.
 */
export function scoreFrom(
  findings: ReadonlyArray<{ severity: Severity }>,
): number {
  const deduction = findings.reduce(
    (sum, finding) => sum + SEVERITY_WEIGHT[finding.severity],
    0,
  );
  return Math.max(0, 100 - deduction);
}

/** The highest severity present, or INFO where nothing was found. */
export function riskLevelFrom(
  findings: ReadonlyArray<{ severity: Severity }>,
): Severity {
  return findings.reduce<Severity>(
    (worst, finding) =>
      SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[worst]
        ? finding.severity
        : worst,
    "INFO",
  );
}

/**
 * The sentence that has to accompany a score wherever it appears.
 *
 * Kept beside the computation so a second place that shows the figure cannot
 * show it without the caveat.
 */
export const SCORE_DISCLAIMER =
  "This score summarises what these checks found in your own books. It is not a measure of honesty, it is not comparable with any other business, and nobody outside this account sees it.";

/** The version of the rule set a run was made under. */
export const RULES_VERSION = "auditor_rules_v1";
