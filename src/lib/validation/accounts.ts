import { z } from "zod";

/**
 * Adding to the chart of accounts.
 *
 * A retailer with an unusual cost — mandi fees, cold-storage hire, a franchise
 * royalty — should be able to give it its own line rather than burying it in
 * Miscellaneous, because an expense that cannot be seen cannot be managed. What
 * they must not be able to do is invent an account that breaks the statements,
 * so the type is chosen from a list and the group is one that already exists.
 */

export const ACCOUNT_TYPES = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "INCOME",
  "EXPENSE",
] as const;

export type AccountTypeInput = (typeof ACCOUNT_TYPES)[number];

/**
 * The sub-types a retailer may pick, per type.
 *
 * Deliberately shorter than the full enum: `RETAINED_EARNINGS` and
 * `ACCUMULATED_DEPRECIATION` exist so the engine can find them, not so somebody
 * can make a second one.
 */
export const SELECTABLE_SUBTYPES: Record<
  AccountTypeInput,
  ReadonlyArray<{ value: string; label: string; hint: string }>
> = {
  ASSET: [
    {
      value: "CURRENT_ASSET",
      label: "Current asset",
      hint: "Something you expect to turn into cash within the year.",
    },
    {
      value: "FIXED_ASSET",
      label: "Fixed asset",
      hint: "Something the shop keeps and uses — fittings, a vehicle, a fridge.",
    },
    {
      value: "CASH_AND_BANK",
      label: "Cash or bank",
      hint: "A till, a bank account, a wallet balance.",
    },
    {
      value: "OTHER_ASSET",
      label: "Other asset",
      hint: "A deposit, an advance paid, anything that does not fit above.",
    },
  ],
  LIABILITY: [
    {
      value: "CURRENT_LIABILITY",
      label: "Current liability",
      hint: "Something owed and payable within the year.",
    },
    {
      value: "LOAN",
      label: "Loan",
      hint: "Borrowed money, repayable over time.",
    },
    {
      value: "TAX_LIABILITY",
      label: "Tax owed",
      hint: "Tax collected or assessed and not yet paid over.",
    },
    {
      value: "OTHER_LIABILITY",
      label: "Other liability",
      hint: "A deposit taken, an advance received, anything else owed.",
    },
  ],
  EQUITY: [
    {
      value: "CAPITAL",
      label: "Capital",
      hint: "Money the owner has put into the business.",
    },
    {
      value: "DRAWINGS",
      label: "Drawings",
      hint: "Money the owner has taken out. Reduces capital, not profit.",
    },
  ],
  INCOME: [
    {
      value: "SALES",
      label: "Sales",
      hint: "Income from trading — the shop's main business.",
    },
    {
      value: "OTHER_INCOME",
      label: "Other income",
      hint: "Interest, rent received, scrap sales — real income, not trading.",
    },
  ],
  EXPENSE: [
    {
      value: "DIRECT_EXPENSE",
      label: "Direct cost",
      hint: "A cost of the goods themselves — freight in, packing, labour on goods.",
    },
    {
      value: "INDIRECT_EXPENSE",
      label: "Running cost",
      hint: "A cost of keeping the shop open — rent, salaries, electricity.",
    },
    {
      value: "FINANCE_COST",
      label: "Finance cost",
      hint: "Interest and bank charges.",
    },
    {
      value: "TAX_EXPENSE",
      label: "Tax expense",
      hint: "Tax that is a cost to the business, not tax it merely collects.",
    },
  ],
};

/** Which side an account of each type normally carries a balance on. */
export const NATURAL_SIDE: Record<AccountTypeInput, "DEBIT" | "CREDIT"> = {
  ASSET: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  INCOME: "CREDIT",
  EXPENSE: "DEBIT",
};

/** Which statement an account of each type lands on. */
export const DEFAULT_SECTION: Record<
  AccountTypeInput,
  "TRADING" | "PROFIT_AND_LOSS" | "BALANCE_SHEET"
> = {
  ASSET: "BALANCE_SHEET",
  LIABILITY: "BALANCE_SHEET",
  EQUITY: "BALANCE_SHEET",
  INCOME: "PROFIT_AND_LOSS",
  EXPENSE: "PROFIT_AND_LOSS",
};

/**
 * Where an account of each sub-type is normally filed.
 *
 * The sub-type already carries the meaning a retailer cares about — a running
 * cost is a running cost — so making them then choose a group is asking the
 * same question twice in accountants' words. The group is pre-filled from this
 * map and remains changeable; anyone who knows they want it somewhere else can
 * say so.
 *
 * Keyed by the seeded group codes. A company that has renumbered its groups
 * falls back to the first group of the right type, which is still valid — the
 * server rejects any group whose type does not match regardless.
 */
export const DEFAULT_GROUP_CODE: Record<string, string> = {
  CURRENT_ASSET: "1150",
  FIXED_ASSET: "1200",
  CASH_AND_BANK: "1110",
  OTHER_ASSET: "1150",
  CURRENT_LIABILITY: "2130",
  PAYABLE: "2110",
  TAX_LIABILITY: "2120",
  LOAN: "2200",
  OTHER_LIABILITY: "2100",
  CAPITAL: "3000",
  DRAWINGS: "3000",
  SALES: "4100",
  OTHER_INCOME: "4200",
  DIRECT_EXPENSE: "5000",
  PURCHASES: "5000",
  INDIRECT_EXPENSE: "6100",
  FINANCE_COST: "6300",
  TAX_EXPENSE: "6100",
};

/** Sub-types that belong above the gross-profit line rather than below it. */
export const TRADING_SUBTYPES = new Set([
  "SALES",
  "PURCHASES",
  "DIRECT_EXPENSE",
]);

const accountCode = z
  .string()
  .trim()
  .min(3, "A code needs at least three characters.")
  .max(20, "Keep the code under 20 characters.")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Use letters, digits, dots, dashes or underscores.",
  );

export const accountSchema = z.object({
  code: accountCode,
  name: z
    .string()
    .trim()
    .min(2, "Give the account a name.")
    .max(80, "Keep the name under 80 characters."),
  groupId: z.string().min(1, "Choose where this account belongs."),
  type: z.enum(ACCOUNT_TYPES),
  subType: z.string().min(1, "Choose what kind of account this is."),
  description: z
    .string()
    .trim()
    .max(300, "Keep the description under 300 characters.")
    .optional()
    .or(z.literal("")),
});

export type AccountInput = z.infer<typeof accountSchema>;

/** Renaming is always allowed. Reclassifying a used account is not. */
export const accountEditSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Give the account a name.")
    .max(80, "Keep the name under 80 characters."),
  description: z
    .string()
    .trim()
    .max(300, "Keep the description under 300 characters.")
    .optional()
    .or(z.literal("")),
});

export type AccountEditInput = z.infer<typeof accountEditSchema>;
