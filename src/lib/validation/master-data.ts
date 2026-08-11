import { z } from "zod";
import { isoDate } from "./date";
import {
  GSTIN_PATTERN,
  INDIAN_MOBILE_PATTERN,
  PAN_PATTERN,
  PINCODE_PATTERN,
  gstIdentityIssue,
} from "@/lib/constants/india";

/**
 * Master data schemas.
 *
 * Shared by the forms and by the server actions behind them: the browser gets
 * immediate feedback, and the server re-validates because a form is a
 * convenience, not a boundary.
 *
 * Two constraints shape everything here. React Hook Form's resolver requires
 * the parsed output type to match the input type, so there are no `.default()`
 * or coercing fields — every value arrives already in its final shape. And
 * money is entered as a `number` for the input element's sake but is converted
 * to exact decimal the moment it reaches the server; nothing is calculated in
 * floating point on the way.
 */

const optionalTrimmed = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal(""));

/** An amount typed into a form. Bounded so a fat-fingered zero run is caught. */
const amount = (label: string, max = 99_99_99_999) =>
  z
    .number({ error: `Enter ${label}.` })
    .min(0, `${label} cannot be negative.`)
    .max(max, `${label} looks too large — check the figure.`)
    .finite();

const quantity = z
  .number({ error: "Enter a quantity." })
  .min(0, "Quantity cannot be negative.")
  .max(99_99_99_999, "That quantity looks too large — check the figure.")
  .finite();

// ---------------------------------------------------------------------------
// Shared party identity
// ---------------------------------------------------------------------------

const gstinField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_PATTERN, "Enter a valid 15-character GSTIN.")
  .optional()
  .or(z.literal(""));

const panField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PAN_PATTERN, "Enter a valid 10-character PAN.")
  .optional()
  .or(z.literal(""));

const phoneField = z
  .string()
  .trim()
  .regex(INDIAN_MOBILE_PATTERN, "Enter a valid 10-digit mobile number.")
  .optional()
  .or(z.literal(""));

const pincodeField = z
  .string()
  .trim()
  .regex(PINCODE_PATTERN, "Enter a valid 6-digit PIN code.")
  .optional()
  .or(z.literal(""));

const emailField = z
  .email("Enter a valid email address.")
  .max(254)
  .optional()
  .or(z.literal(""));

/**
 * Opening balances are entered as a positive figure plus a side, never as a
 * negative number. "−50,000 receivable" and "50,000 payable" are the same
 * position stated two ways, and only one of them is unambiguous on a form.
 */
export const OPENING_NATURE = ["DEBIT", "CREDIT"] as const;
const openingNatureField = z.enum(OPENING_NATURE);

const partyFields = {
  name: z
    .string()
    .trim()
    .min(2, "Enter a name.")
    .max(160, "That name is too long."),
  phone: phoneField,
  email: emailField,
  gstin: gstinField,
  pan: panField,
  addressLine1: optionalTrimmed(200),
  city: optionalTrimmed(80),
  stateCode: optionalTrimmed(2),
  pincode: pincodeField,
  creditDays: z
    .number()
    .int("Enter whole days.")
    .min(0, "Credit days cannot be negative.")
    .max(365, "Use 365 days or fewer."),
  openingBalance: amount("an opening balance"),
  openingNature: openingNatureField,
  notes: optionalTrimmed(500),
};

/** The GSTIN cross-checks, wired into a schema. */
function withGstChecks<
  T extends z.ZodType<{ gstin?: string; pan?: string; stateCode?: string }>,
>(schema: T) {
  return schema.superRefine((data, ctx) => {
    const issue = gstIdentityIssue(data);
    if (issue) {
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: [issue.field],
      });
    }
  });
}

export const customerSchema = withGstChecks(
  z.object({
    ...partyFields,
    creditLimit: amount("a credit limit"),
  }),
);

export type CustomerInput = z.infer<typeof customerSchema>;

export const supplierSchema = withGstChecks(z.object({ ...partyFields }));

export type SupplierInput = z.infer<typeof supplierSchema>;

/**
 * What the shared customer/supplier form binds to.
 *
 * A supplier's fields are a subset of a customer's — only the credit limit
 * differs — so the form validates against the wider shape and the action drops
 * the field the server-side supplier schema does not accept. Two near-identical
 * forms would be the alternative, and they would drift.
 */
export const partyFormSchema = customerSchema;
export type PartyFormInput = CustomerInput;

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/**
 * HSN for goods is 4, 6 or 8 digits; SAC for services is 6. Anything else is a
 * transcription error, and an invalid code on an invoice is a GST return that
 * will not reconcile.
 */
export const HSN_PATTERN = /^(\d{4}|\d{6}|\d{8})$/;

export const productSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .min(2, "Enter a product code.")
      .max(40, "Keep the code to 40 characters or fewer.")
      .regex(
        /^[A-Z0-9][A-Z0-9._/-]*$/,
        "Use letters, numbers and . _ / - only.",
      ),
    name: z
      .string()
      .trim()
      .min(2, "Enter the product name.")
      .max(160, "That name is too long."),
    description: optionalTrimmed(500),
    barcode: optionalTrimmed(40),
    hsnCode: z
      .string()
      .trim()
      .regex(HSN_PATTERN, "An HSN code is 4, 6 or 8 digits; a SAC is 6.")
      .optional()
      .or(z.literal("")),
    categoryId: optionalTrimmed(64),
    unitId: z.string().min(1, "Choose a unit of measure."),
    taxRateId: optionalTrimmed(64),

    purchasePrice: amount("a purchase price"),
    sellingPrice: amount("a selling price"),
    /** Zero means "not printed on the pack", not "free". */
    mrp: amount("an MRP"),

    isStockTracked: z.boolean(),
    openingQuantity: quantity,
    openingRate: amount("an opening rate"),
    minStockLevel: quantity,
  })
  .superRefine((data, ctx) => {
    if (data.mrp > 0 && data.mrp < data.sellingPrice) {
      ctx.addIssue({
        code: "custom",
        path: ["mrp"],
        message: "MRP cannot be below the selling price.",
      });
    }

    // A service has no stock ledger, so opening stock has nowhere to go.
    if (!data.isStockTracked && data.openingQuantity > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["openingQuantity"],
        message:
          "This is not stock-tracked, so it cannot carry an opening quantity.",
      });
    }

    if (data.openingQuantity > 0 && data.openingRate <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["openingRate"],
        message:
          "Opening stock needs a cost per unit — it is what values the stock on your balance sheet.",
      });
    }
  });

export type ProductInput = z.infer<typeof productSchema>;

/**
 * A selling price below cost is a real decision (a loss leader, clearing old
 * stock), so it is a warning the form shows rather than an error that blocks.
 */
export function marginWarning(input: {
  purchasePrice: number;
  sellingPrice: number;
}): string | null {
  if (input.purchasePrice <= 0 || input.sellingPrice <= 0) return null;
  if (input.sellingPrice < input.purchasePrice) {
    return "The selling price is below the purchase price — every sale of this item will book a loss.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Enter a category name.")
    .max(80, "That name is too long."),
  parentId: optionalTrimmed(64),
  description: optionalTrimmed(200),
});

export type CategoryInput = z.infer<typeof categorySchema>;

export const unitSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Enter a short code, e.g. KG.")
    .max(8, "Keep the code to 8 characters or fewer.")
    .regex(/^[A-Z0-9]+$/, "Use letters and numbers only."),
  name: z.string().trim().min(2, "Enter the unit name.").max(40),
  /** Decimal places allowed on a quantity: 0 for pieces, 3 for kilograms. */
  precision: z
    .number()
    .int("Enter a whole number.")
    .min(0, "Cannot be negative.")
    .max(3, "Three decimal places is the maximum."),
});

export type UnitInput = z.infer<typeof unitSchema>;

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const EMPLOYEE_STATUS = [
  "ACTIVE",
  "ON_LEAVE",
  "RESIGNED",
  "TERMINATED",
] as const;

export const employeeSchema = z
  .object({
    name: z.string().trim().min(2, "Enter their name.").max(120),
    email: emailField,
    phone: phoneField,
    department: optionalTrimmed(80),
    designation: optionalTrimmed(80),
    joiningDate: isoDate,
    exitDate: isoDate.optional().or(z.literal("")),
    status: z.enum(EMPLOYEE_STATUS),
    basicSalary: amount("a basic salary"),
    allowances: amount("an allowance figure"),
    panNumber: panField,
    bankAccountNo: optionalTrimmed(24),
    ifsc: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid 11-character IFSC.")
      .optional()
      .or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    if (data.exitDate && data.exitDate < data.joiningDate) {
      ctx.addIssue({
        code: "custom",
        path: ["exitDate"],
        message: "The leaving date cannot be before the joining date.",
      });
    }

    // Payroll for someone who has left would post salary they are not owed.
    const hasLeft = data.status === "RESIGNED" || data.status === "TERMINATED";
    if (hasLeft && !data.exitDate) {
      ctx.addIssue({
        code: "custom",
        path: ["exitDate"],
        message: "Record the date they left.",
      });
    }
    if (!hasLeft && data.exitDate) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A leaving date is set, so choose Resigned or Terminated.",
      });
    }
  });

export type EmployeeInput = z.infer<typeof employeeSchema>;
