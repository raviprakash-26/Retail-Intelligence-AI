import { Prisma } from "@prisma/client";

/**
 * What leaves in a data export, and what deliberately does not.
 *
 * A business's books belong to the business. This module is the reason a shop
 * can take them somewhere else — to their accountant at year end, to another
 * product, or into a drawer against the day somebody asks for records from six
 * years ago. A bookkeeping product that cannot answer "send me my data" is one
 * that holds it hostage, and everything else this codebase does to avoid
 * overclaiming to a shopkeeper would be undone by that.
 *
 * **The safety boundary is a list, not a filter.** Fifty-two tables carry a
 * `companyId`, and a few of them hold material that must never be handed to
 * anybody: `Session` holds live session tokens, `VerificationToken` holds the
 * hashes behind password resets, `PaymentEvent` holds raw provider webhooks.
 * Selecting every scalar column of every scoped table would put all of that in
 * a file the owner can email. So every company-scoped model is classified here
 * as exported or withheld — with the reason written down — and a test fails if
 * a new one appears in neither. A table added next year cannot leak by default;
 * it has to be named first.
 *
 * The field denylist is the second line rather than the first. Nothing in the
 * exported set should carry a secret, but a column added to an exported table
 * later might, so names that mean "credential" are refused wherever they appear.
 */

/**
 * Columns never exported, on any table.
 *
 * Matched case-insensitively against the whole field name so a future
 * `resetTokenHash` or `webhookSecret` is caught by the same rule. Deliberately
 * blunt: a false positive costs a column nobody needed in a CSV, and a false
 * negative is a credential in a customer's downloads folder.
 */
export const DENIED_FIELDS = [
  "password",
  "passwordhash",
  "tokenhash",
  "token",
  "secret",
  "signature",
  "apikey",
  "rawbody",
  "payload",
  "credential",
] as const;

export function fieldIsDenied(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_FIELDS.some((denied) => lower.includes(denied));
}

/**
 * Tables that stay behind, and why.
 *
 * The reason is not decoration — it is printed in the export's own manifest, so
 * a person reading the zip can see what they did not get and decide whether to
 * ask for it, rather than assuming the file is everything and discovering
 * otherwise during a migration.
 */
export const WITHHELD_MODELS: Record<string, string> = {
  Session: "Live sign-in sessions, which carry credentials.",
  VerificationToken:
    "Hashes behind email verification and password resets, which carry credentials.",
  PaymentEvent:
    "Raw webhooks from the payment provider, which carry provider signatures.",
  Subscription:
    "The billing relationship with this platform, which is not part of your books.",
  Notification: "Interface notices, which hold nothing your books do not.",
  DocumentSequence:
    "Internal numbering counters. The numbers themselves are on the documents.",
  InventoryBalance:
    "A cached position rebuilt from stock movements, which are included.",
  Forecast: "Projections recomputed on demand; nothing is recorded here.",
};

/**
 * The order the files appear in, chosen so a reader can follow the books.
 *
 * Masters first, then the ledger the whole system rests on, then the documents
 * that produced it, then the derived positions. Anything company-scoped and not
 * named here or in `WITHHELD_MODELS` fails the classification test.
 */
export const EXPORTED_MODELS: readonly string[] = [
  // What the business is
  "Branch",
  "FiscalYear",
  "FiscalPeriod",
  "Role",
  "Membership",

  // Masters
  "Category",
  "Unit",
  "TaxRate",
  "Product",
  "Customer",
  "Supplier",
  "Employee",
  "ExpenseCategory",
  "BankAccount",
  "FixedAsset",

  // The ledger
  "AccountGroup",
  "Account",
  "JournalEntry",
  "JournalLine",

  // What produced it
  "Sale",
  "SaleItem",
  "SalesReturn",
  "SalesReturnItem",
  "Purchase",
  "PurchaseItem",
  "PurchaseReturn",
  "PurchaseReturnItem",
  "Expense",
  "Receipt",
  "ReceiptAllocation",
  "Payment",
  "PaymentAllocation",
  "Payroll",
  "PayrollItem",
  "DepreciationEntry",

  // Stock, tax and banking
  "InventoryMovement",
  "GstTransaction",
  "GstPeriod",
  "BankTransaction",

  // The record of what was done
  "AuditLog",
  "AuditRun",
  "AuditFinding",
  "AiConversation",
  "AiMessage",
];

export type ModelField = { name: string; type: string };

/** Every company-scoped model Prisma knows about, with its scalar columns. */
export function companyScopedModels(): Array<{
  name: string;
  fields: ModelField[];
}> {
  return Prisma.dmmf.datamodel.models
    .filter((model) =>
      model.fields.some(
        (field) => field.name === "companyId" && field.kind === "scalar",
      ),
    )
    .map((model) => ({
      name: model.name,
      fields: model.fields
        .filter((field) => field.kind === "scalar" || field.kind === "enum")
        .map((field) => ({ name: field.name, type: field.type })),
    }));
}

/**
 * Company-scoped models named in neither list.
 *
 * Empty is the only acceptable answer, and a test says so. This is the guard
 * that makes the whole module safe over time: a table added to the schema in
 * six months does not quietly join the export, and does not quietly fall out
 * of it either — somebody has to decide which, in writing.
 */
export function unclassifiedModels(): string[] {
  const known = new Set([...EXPORTED_MODELS, ...Object.keys(WITHHELD_MODELS)]);
  return companyScopedModels()
    .map((model) => model.name)
    .filter((name) => !known.has(name))
    .sort();
}

/** The columns of one exported model, in schema order, minus anything denied. */
export function exportedFields(model: {
  name: string;
  fields: ModelField[];
}): ModelField[] {
  return model.fields.filter((field) => !fieldIsDenied(field.name));
}

/** The file each model is written to inside the archive. */
export function fileNameFor(model: string): string {
  // snake_case: these are opened in Excel and Tally by people who did not
  // choose the schema's naming, and `sale_items.csv` reads better there.
  return `${model.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`;
}
