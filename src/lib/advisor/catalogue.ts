/**
 * What the advisor is allowed to suggest, and how it is allowed to say it.
 *
 * The suggestions themselves are produced by queries over posted entries, not
 * by a model. This file holds the wording around each one: what it is, what to
 * do about it, and — the part that matters most — when it does not apply.
 *
 * Every suggestion here is a suggestion about a shop the software has only ever
 * seen through its own books. It has not met the customers, does not know which
 * supplier is reliable, and cannot tell a slow month from a deliberate one. So
 * nothing in this catalogue promises an outcome, and every entry carries the
 * reasons a sensible owner might read it and correctly decide to do nothing.
 */

export const SUGGESTION_KEYS = [
  "OVERDUE_RECEIVABLES",
  "OVERDUE_PAYABLES",
  "CASH_SHORTFALL_AHEAD",
  "SLOW_MOVING_STOCK",
  "STOCK_OUT_RISK",
  "LOW_MARGIN_PRODUCT",
  "MARGIN_SLIPPING",
  "CUSTOMER_CONCENTRATION",
  "EXPENSE_GROWING_FASTER_THAN_SALES",
  "SHORT_ON_WORKING_CAPITAL",
  "CASH_TIED_UP_TOO_LONG",
] as const;

export type SuggestionKey = (typeof SUGGESTION_KEYS)[number];

export type Category = "CASH" | "STOCK" | "MARGIN" | "CUSTOMERS" | "COSTS";

/** How much of the owner's time and disruption acting on this would take. */
export type Effort = "SMALL" | "MEDIUM" | "LARGE";

/** When it is worth looking at, not how alarming it is. */
export type Urgency = "NOW" | "SOON" | "WHEN_YOU_CAN";

export type SuggestionRule = {
  key: SuggestionKey;
  category: Category;
  /** Plain, and about the books rather than about the owner. */
  title: string;
  /** The step to take. A thing to do this week, not a strategy. */
  whatToDo: string;
  /**
   * Why a reasonable owner might read this and do nothing. Every one of these
   * is a case the queries cannot see, which is exactly why they are written
   * down rather than left to the reader to think of.
   */
  whenThisDoesNotApply: readonly string[];
  effort: Effort;
  urgency: Urgency;
  /** Which computed figures produced it, named so the reader can go and check. */
  basis: string;
  /**
   * True where acting on it is a decision with tax, legal or financing
   * consequences that this software is not in a position to weigh.
   */
  needsProfessional: boolean;
};

export const URGENCY_ORDER: Record<Urgency, number> = {
  NOW: 3,
  SOON: 2,
  WHEN_YOU_CAN: 1,
};

export const EFFORT_LABEL: Record<Effort, string> = {
  SMALL: "An afternoon",
  MEDIUM: "A few days",
  LARGE: "A few weeks",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  CASH: "Cash",
  STOCK: "Stock",
  MARGIN: "Margin",
  CUSTOMERS: "Customers",
  COSTS: "Costs",
};

export const CATALOGUE_VERSION = "advisor_catalogue_v1";

export const RULES: Record<SuggestionKey, SuggestionRule> = {
  OVERDUE_RECEIVABLES: {
    key: "OVERDUE_RECEIVABLES",
    category: "CASH",
    title: "Money already earned is sitting with customers",
    whatToDo:
      "Work down the list oldest first and ask for each one by name. A statement of account for the customer is one click away on their ledger page, and asking for a specific invoice on a specific date collects more than a general reminder.",
    whenThisDoesNotApply: [
      "You have already agreed longer credit with these customers than the invoice says, in which case the due dates on the invoices are what need fixing, not the customers.",
      "One of them is a large buyer whose payment run is monthly, and chasing on day 31 costs more goodwill than the fortnight of cash is worth.",
      "The amount is disputed and the dispute is genuine, in which case settling the dispute is the collection.",
    ],
    effort: "SMALL",
    urgency: "SOON",
    basis: "The receivables ageing, from each invoice's own due date.",
    needsProfessional: false,
  },

  OVERDUE_PAYABLES: {
    key: "OVERDUE_PAYABLES",
    category: "CASH",
    title: "Bills you owe are past their due date",
    whatToDo:
      "Go through them oldest first and decide which to pay, which to part-pay, and which to ring about. A supplier told on Monday that payment is coming Friday is a supplier who keeps supplying; the same supplier finding out by chasing is the one who asks for cash on delivery next time.",
    whenThisDoesNotApply: [
      "The due date in the books is the invoice's printed term, but you and this supplier have always worked to a longer one that was never written down anywhere the software can see.",
      "The bill is in dispute — short delivery, wrong price, damaged goods — and is deliberately unpaid until it is settled.",
      "It was paid in cash and the payment was never recorded against the bill, so it is closed in the shop and open in the books.",
    ],
    effort: "SMALL",
    // Not NOW: unlike a projected shortfall this is a position rather than an
    // event, and a shop with an arrangement is not in trouble. It rises on its
    // own if the amount is large against this shop's turnover.
    urgency: "SOON",
    basis:
      "Supplier bills posted and unpaid, aged against the due date on each one.",
    // Which bills to pay first when there is not enough for all of them is a
    // question with consequences this software cannot weigh.
    needsProfessional: false,
  },

  CASH_SHORTFALL_AHEAD: {
    key: "CASH_SHORTFALL_AHEAD",
    category: "CASH",
    title: "The cash projection dips below nil",
    whatToDo:
      "Look at the week it happens and decide which of the three levers you would rather pull: collect earlier, pay later, or arrange cover before you need it. Arranging it in advance is cheaper than arranging it in the week.",
    whenThisDoesNotApply: [
      "You hold cash outside the books — a personal account you top the shop up from — which the projection cannot see and therefore does not count.",
      "The bills landing that week are ones you routinely pay late by agreement, so the dip is on paper rather than in the bank.",
      "Takings that week are seasonal in a way a few months of history does not yet show.",
    ],
    effort: "MEDIUM",
    urgency: "NOW",
    basis:
      "The cash projection: invoices raised, bills received, and what the shop spends to keep running.",
    needsProfessional: true,
  },

  SLOW_MOVING_STOCK: {
    key: "SLOW_MOVING_STOCK",
    category: "STOCK",
    title: "Stock that has not moved is holding cash",
    whatToDo:
      "Decide item by item whether it sells at a discount, goes back to the supplier, or gets written down. Stock that will not sell at any price is a loss that has already happened — recording it changes nothing except how accurate your figures are.",
    whenThisDoesNotApply: [
      "The item is seasonal and its season has not come round yet.",
      "It is a spare or a slow line you keep because a customer expects to find it, and losing that customer costs more than the shelf space.",
      "It was bought deliberately at a price that will not come round again.",
    ],
    effort: "MEDIUM",
    urgency: "WHEN_YOU_CAN",
    basis:
      "Stock on hand at what it cost, against the date each item last moved.",
    needsProfessional: false,
  },

  STOCK_OUT_RISK: {
    key: "STOCK_OUT_RISK",
    category: "STOCK",
    title: "Lines that sell are running low",
    whatToDo:
      "Reorder these before the weekend. A customer who finds an empty shelf twice starts checking somewhere else first, and that is a cost no ledger ever shows.",
    whenThisDoesNotApply: [
      "The line is being discontinued deliberately and running it down is the plan.",
      "Your supplier delivers next day, so a low shelf is a full one tomorrow.",
      "Recent sales were one bulk order rather than steady demand, which makes the rate look higher than it is.",
    ],
    effort: "SMALL",
    urgency: "SOON",
    basis: "Quantity on hand against the reorder level set for each product.",
    needsProfessional: false,
  },

  LOW_MARGIN_PRODUCT: {
    key: "LOW_MARGIN_PRODUCT",
    category: "MARGIN",
    title: "Some lines sell well and earn little",
    whatToDo:
      "Check the buying price and the selling price on these against what you assumed. A small rise on a line that sells every day is worth more than a large rise on one that does not, and costs less goodwill than it sounds like it should.",
    whenThisDoesNotApply: [
      "The line is what brings people through the door and they buy other things once inside.",
      "The price is set by the supplier or printed on the pack, and there is nothing to move.",
      "You are holding the price deliberately while a competitor down the road tries to outlast you.",
    ],
    effort: "MEDIUM",
    urgency: "WHEN_YOU_CAN",
    basis:
      "Revenue and cost captured on each invoice line, against this shop's own average margin.",
    needsProfessional: false,
  },

  MARGIN_SLIPPING: {
    key: "MARGIN_SLIPPING",
    category: "MARGIN",
    title: "Gross margin is lower than the period before",
    whatToDo:
      "Compare buying prices on your largest lines with the ones from the earlier period. Margin falls for a reason, and it is nearly always either a supplier price that went up quietly or a discount that became a habit.",
    whenThisDoesNotApply: [
      "The mix changed — you sold more of a thinner line and less of a fat one — which moves the average without anything being wrong.",
      "There was a deliberate promotion in the period.",
      "A large one-off sale at a keen price sits inside the window.",
    ],
    effort: "MEDIUM",
    urgency: "SOON",
    basis:
      "Gross profit against revenue, this period and the same length before it.",
    needsProfessional: false,
  },

  CUSTOMER_CONCENTRATION: {
    key: "CUSTOMER_CONCENTRATION",
    category: "CUSTOMERS",
    title: "A large share of sales comes from one customer",
    whatToDo:
      "Nothing urgent, and nothing about this customer — they are your best one. It is worth knowing what the month looks like without them, and worth spending some of the time they free up on finding the next one.",
    whenThisDoesNotApply: [
      "They are on a contract long enough that the concentration is a strength rather than an exposure.",
      "The business is new, and early revenue almost always comes from a handful of names.",
      "They are a related business whose custom is not going anywhere.",
    ],
    effort: "LARGE",
    urgency: "WHEN_YOU_CAN",
    basis: "Each customer's share of the period's invoice revenue.",
    needsProfessional: false,
  },

  EXPENSE_GROWING_FASTER_THAN_SALES: {
    key: "EXPENSE_GROWING_FASTER_THAN_SALES",
    category: "COSTS",
    title: "Running costs are growing faster than sales",
    whatToDo:
      "Open the expense breakdown and look at the two or three categories that moved most. Costs rarely rise all at once — usually one or two did, and they are easier to find in a list than in a total.",
    whenThisDoesNotApply: [
      "You spent deliberately on something whose return has not arrived yet — new staff, a new branch, a delivery van.",
      "An annual payment such as insurance or a licence fell inside this period and not the last one.",
      "The earlier period was unusually quiet, which flatters the comparison rather than damning this one.",
    ],
    effort: "MEDIUM",
    urgency: "SOON",
    basis:
      "Operating expenses and revenue, this period against the same length before it.",
    needsProfessional: false,
  },

  SHORT_ON_WORKING_CAPITAL: {
    key: "SHORT_ON_WORKING_CAPITAL",
    category: "CASH",
    title: "Short-term liabilities are larger than short-term assets",
    whatToDo:
      "Look at what falls due in the next month against what you expect to collect. This is worth a conversation with your accountant before it is worth a decision.",
    whenThisDoesNotApply: [
      "A director's or owner's loan sits in current liabilities and is not going to be called.",
      "Your stock turns faster than your suppliers' credit terms, which is how a healthy shop can run below one on paper indefinitely.",
      "A large payment landed just before the period ended and the position a week later looks nothing like this.",
    ],
    effort: "MEDIUM",
    urgency: "SOON",
    basis: "The current ratio, from the balances on the balance sheet.",
    needsProfessional: true,
  },

  CASH_TIED_UP_TOO_LONG: {
    key: "CASH_TIED_UP_TOO_LONG",
    category: "CASH",
    title: "Cash spends a long time as stock and invoices",
    whatToDo:
      "The cycle shortens from three directions: sell stock sooner, collect sooner, or pay later. Pick whichever of the three you have the most room in — a week off any one of them is the same week of cash.",
    whenThisDoesNotApply: [
      "The trade you are in has a long cycle by nature, and comparing it against a cash-and-carry shop means nothing.",
      "You buy in bulk once a season because that is where the buying price is.",
      "You have deliberately extended credit to win a customer worth having.",
    ],
    effort: "LARGE",
    urgency: "WHEN_YOU_CAN",
    basis: "Inventory days plus receivable days, less payable days.",
    needsProfessional: false,
  },
};

export const RULE_LIST: readonly SuggestionRule[] = SUGGESTION_KEYS.map(
  (key) => RULES[key],
);

export function ruleList(): readonly SuggestionRule[] {
  return RULE_LIST;
}

/**
 * Words that promise an outcome.
 *
 * The advisor is reading a shop's own books and nothing else. It has no
 * standing to say that anything *will* happen, and a small business owner who
 * acts on "this will increase your profit" and is wrong has been misled by
 * software that had no way of knowing. Suggestions may say what the books show
 * and what usually helps. They may not guarantee.
 */
export const PROMISE_WORDS = [
  "guarantee",
  "guaranteed",
  "will increase",
  "will improve",
  "will grow",
  "will double",
  "risk-free",
  "riskless",
  "no risk",
  "assured",
  "certain to",
  "definitely",
  "always works",
  "you must",
  "you should immediately",
] as const;

/**
 * Matched on whole words, because "indefinitely" contains "definitely" and a
 * shop whose stock turns faster than its suppliers' credit terms can run below
 * a current ratio of one indefinitely — which is a fact about trade, not a
 * promise about anything.
 */
const PROMISE_PATTERNS = PROMISE_WORDS.map(
  (word) =>
    new RegExp(`\\b${word.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i"),
);

export function promises(text: string): boolean {
  return PROMISE_PATTERNS.some((pattern) => pattern.test(text));
}

export const ADVISOR_DISCLAIMER =
  "These suggestions are worked out from your own books and nothing else. They are not financial, tax or legal advice, they do not know anything about your trade that your entries do not show, and a suggestion that does not fit your circumstances is one you are right to ignore.";

export const PROFESSIONAL_NOTE =
  "This one has consequences worth talking through with your accountant before acting on it.";
