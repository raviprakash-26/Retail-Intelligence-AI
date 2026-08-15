/**
 * What the AI Accountant is told, and why each line is there.
 *
 * A prompt is not a security boundary. Everything that actually matters here is
 * enforced somewhere else — the tools cannot write, the tenant is bound by the
 * runner, and an answer quoting a figure with no tool behind it is marked as
 * unverified before anyone reads it. These instructions exist to make the
 * assistant *useful* within those limits, and to make its refusals sound like
 * an accountant rather than an error message.
 *
 * Kept as a constant so the rules can be asserted in a test. A prompt that
 * quietly loses its "you do not calculate" line is the kind of regression that
 * ships without anybody noticing.
 */

export type PromptContext = {
  businessName: string;
  /** Today, so relative questions like "this month" resolve correctly. */
  today: string;
  fiscalYearLabel: string | null;
  fiscalYearFrom: string | null;
  fiscalYearTo: string | null;
  currency: string;
};

/** The rules that must survive any edit. Asserted by name in the tests. */
export const PROMPT_RULES = {
  noArithmetic:
    "You do not calculate financial figures. Every number you state must come from a tool result you have just received.",
  noWrites:
    "You cannot change anything. You cannot post, edit, void or delete a transaction.",
  notAdvice:
    "You are not a chartered accountant and not a tax adviser, and you must not present yourself as one.",
  oneBusiness:
    "You can only see this one business. You have no access to any other company's records.",
  admitGaps:
    "If a tool cannot answer something, say so plainly. Never fill a gap with a plausible number.",
} as const;

export function systemPrompt(context: PromptContext): string {
  const year =
    context.fiscalYearLabel && context.fiscalYearFrom && context.fiscalYearTo
      ? `The current financial year is ${context.fiscalYearLabel}, running from ${context.fiscalYearFrom} to ${context.fiscalYearTo}.`
      : "No financial year has been set up yet.";

  return `You are the accountant for ${context.businessName}, a small retail business in India. You answer questions about its books.

Today is ${context.today}. ${year} Amounts are in ${context.currency}.

## What you must not do

${PROMPT_RULES.noArithmetic} If you want a total, a margin, a balance or a tax figure, call the tool that produces it. Do not add, subtract, average or extrapolate the figures a tool gives you — if the answer needs a calculation nobody has done, say which report would show it rather than working it out.

${PROMPT_RULES.noWrites} When asked to, say so and point at the page that can: sales at /app/sales/new, purchases at /app/purchases/new, expenses at /app/expenses/new, receipts at /app/receipts/new, payments at /app/payments/new, and a manual journal entry at /app/accounting/journal.

${PROMPT_RULES.notAdvice} You can explain what a figure means and what the books show. You must not tell anyone what to declare, what to claim, or how to structure anything. Where a question turns on judgement, say that it is one for their accountant.

${PROMPT_RULES.oneBusiness} If asked to compare with another business, or about anyone else's numbers, say plainly that you cannot see them.

${PROMPT_RULES.admitGaps} A wrong number stated confidently is worse than no answer.

## How to answer

Call a tool before quoting any figure. Several tools if the question needs
several — do not guess at one to avoid a second call.

Quote figures exactly as the tool gave them. Do not round them into
approximations, and do not restate a range as a single number: where a tool
returns a low and a high, both belong in your answer.

Where a tool returns a null with a reason, give the reason. "Stock turnover
could not be computed because there was no stock at either end of the period"
is an answer; "stock turnover is 0" is not.

Keep it short. A shopkeeper asked a question, not for a report. Two or three
sentences is usually right, with a table only when the question was about
several rows.

Use plain words. "You are owed ₹40,000 and about half of it is more than a
month old" beats "receivables aged 30+ days constitute approximately 50% of
gross trade debtors".

Say "prepared for review" about anything to do with GST or income tax. Nothing
in this product has been filed with anybody, and nothing in it can file.`;
}

/**
 * Every money-shaped figure in a piece of text, as numbers.
 *
 * Deliberately narrow: rupee amounts and bare two-decimal amounts, which is
 * what a stated financial figure looks like. A bare integer is not matched —
 * "3 customers" and "2026" are not claims about money, and treating them as
 * such would flag every answer ever written.
 */
export function statedFigures(text: string): number[] {
  const found: number[] = [];
  const pattern = /₹\s?([\d,]+(?:\.\d+)?)|\b(\d[\d,]*\.\d{2})\b/g;

  for (const match of text.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? "").replace(/,/g, "");
    if (raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/** Every number appearing anywhere in a tool result, however deeply nested. */
function numbersWithin(value: unknown, into: Set<number>): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) into.add(round2(value));
    return;
  }
  if (typeof value === "string") {
    // Amounts cross the wire as strings — "104522.0000" — so a string that is
    // wholly a number counts, and one that merely contains digits does not.
    const trimmed = value.trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
      into.add(round2(Number(trimmed)));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) numbersWithin(entry, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) numbersWithin(entry, into);
  }
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Whether an answer states money the tools did not produce.
 *
 * The one check that does not rely on the model behaving, and the only thing
 * standing between "do not add the figures a tool gives you" being a rule and
 * being enforced.
 *
 * It used to ask only whether *any* tool had been called in the turn. That
 * caught the worst case — a figure invented with no query at all — and missed
 * the more likely one: a model that fetches revenue and expenses, adds them in
 * its head, and states a profit that appears in no tool result. The prompt
 * forbids exactly that, and counting calls cannot see it.
 *
 * So every money-shaped figure in the answer is now looked for in what the
 * tools actually returned. A figure that is not there was not traced to a
 * query, however many queries were run, and the interface says so.
 *
 * Deliberately not a correctness check. A figure that matches a tool result is
 * not thereby the *right* figure for the question — this establishes only that
 * the model did not make the number up, which is the claim the page makes.
 */
export function statesUnverifiedFigures(
  text: string,
  toolResults: readonly unknown[] | number,
): boolean {
  const results = typeof toolResults === "number" ? null : toolResults;
  const toolCount = results ? results.length : toolResults;

  // Nothing was asked. Any money-shaped text is a figure from the model's own
  // head — including one spelled out in words, which no arithmetic can check
  // but which is just as invented.
  if (toolCount === 0) {
    return /₹\s?[\d,]+|\b\d[\d,]*\.\d{2}\b|\brupees\b/i.test(text);
  }

  // Tools ran, but a caller that only counted them cannot say which figures
  // came back. Nothing more can be established than the count already did.
  if (!results) return false;

  const figures = statedFigures(text);
  if (figures.length === 0) return false;

  const known = new Set<number>();
  for (const result of results) numbersWithin(result, known);

  return figures.some((figure) => !known.has(round2(figure)));
}
