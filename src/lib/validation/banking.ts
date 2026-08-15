import { z } from "zod";

/**
 * What a bank form is allowed to send.
 *
 * Account numbers and IFSC codes are stored so a person can tell two accounts
 * apart on screen. Nothing here is used to move money — there is no payment
 * integration — so the fields are descriptive, and the schema does not pretend
 * to validate an account number against anything.
 */

const trimmed = (max: number) =>
  z.string().trim().max(max, `Keep this under ${max} characters.`);

const optionalTrimmed = (max: number) =>
  trimmed(max)
    .optional()
    .transform((value) => (value === "" ? undefined : value));

/** Mirrors the `BankAccountType` enum in the schema, in the order a form offers. */
export const BANK_ACCOUNT_TYPES = [
  "CURRENT",
  "SAVINGS",
  "OD",
  "CASH_CREDIT",
  "WALLET",
] as const;

export const BANK_ACCOUNT_TYPE_LABELS: Record<
  (typeof BANK_ACCOUNT_TYPES)[number],
  string
> = {
  CURRENT: "Current account",
  SAVINGS: "Savings account",
  OD: "Overdraft",
  CASH_CREDIT: "Cash credit",
  WALLET: "Wallet",
};

export const bankAccountSchema = z.object({
  name: trimmed(120).min(2, "Give this account a name you will recognise."),
  /** The ledger account it posts to — always one of the company's own. */
  accountId: z.uuid("Choose the ledger account this bank account belongs to."),
  bankName: optionalTrimmed(120),
  accountNumber: optionalTrimmed(32),
  /** Four letters, a zero, then six alphanumerics. */
  ifsc: optionalTrimmed(11).refine(
    (value) =>
      value === undefined || /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(value),
    "An IFSC code is four letters, a zero, then six characters.",
  ),
  branchName: optionalTrimmed(120),
  type: z.enum(BANK_ACCOUNT_TYPES).default("CURRENT"),
});

export type BankAccountInput = z.input<typeof bankAccountSchema>;
export type BankAccountValues = z.output<typeof bankAccountSchema>;

/**
 * A statement upload.
 *
 * The file arrives as text rather than as a file handle: it is parsed on the
 * server, and the size cap is here because a CSV large enough to exhaust memory
 * is a denial of service rather than a statement.
 */
export const statementImportSchema = z.object({
  bankAccountId: z.uuid(),
  /** The file's contents. 8 MB of CSV is roughly 80,000 statement lines. */
  content: z
    .string()
    .min(1, "That file is empty.")
    .max(8_000_000, "That file is too large. Split it by month and try again."),
  fileName: optionalTrimmed(200),
});

export type StatementImportInput = z.input<typeof statementImportSchema>;

export const matchSchema = z.object({
  bankTransactionId: z.uuid(),
  journalEntryId: z.uuid(),
});

export const unmatchSchema = z.object({
  bankTransactionId: z.uuid(),
});

/**
 * Recording a charge or interest the bank applied and the books never saw.
 *
 * Deliberately the only posting this module can make, and deliberately narrow:
 * these two are the items that genuinely originate on the statement. Everything
 * else — a receipt, a payment, an expense — is recorded in the module that owns
 * it, because a bank page that could post anything would become a second, less
 * careful way to write to the ledger.
 */
export const recordFromStatementSchema = z.object({
  bankTransactionId: z.uuid(),
  kind: z.enum(["BANK_CHARGE", "INTEREST_RECEIVED", "INTEREST_PAID"]),
  narration: optionalTrimmed(200),
});

export type RecordFromStatementInput = z.input<
  typeof recordFromStatementSchema
>;
