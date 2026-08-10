import { z } from "zod";
import {
  GSTIN_PATTERN,
  INDIAN_MOBILE_PATTERN,
  PAN_PATTERN,
  PINCODE_PATTERN,
  gstinStateCode,
  panFromGstin,
} from "@/lib/constants/india";
// Imported from the policy module, not from `@/lib/auth/password`: the latter
// is server-only, and these schemas are shared with client forms.
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/password-policy";

/**
 * Shared validation schemas.
 *
 * These are imported by both the client form and the server action, so the
 * browser and the server enforce identical rules. Client-side validation is a
 * convenience; the server-side parse is the one that counts.
 */

export const emailSchema = z
  .email("Enter a valid email address.")
  .max(254, "Email address is too long.")
  .transform((value) => value.trim().toLowerCase());

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

export const mobileSchema = z
  .string()
  .trim()
  .regex(INDIAN_MOBILE_PATTERN, "Enter a valid 10-digit Indian mobile number.");

export const loginSchema = z.object({
  email: emailSchema,
  // Deliberately only a presence check: telling a user their password is "too
  // short" at the login screen is a hint about the stored credential.
  password: z.string().min(1, "Enter your password."),
  rememberMe: z.boolean(),
});

export type LoginInput = z.infer<typeof loginSchema>;

// --- Registration: step 1, the person -------------------------------------

export const registerAccountSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, "Enter your full name.")
      .max(120, "Name is too long."),
    email: emailSchema,
    mobile: mobileSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    // Modelled as a boolean with a refinement rather than `z.literal(true)`
    // so the form's initial (unchecked) value is representable and the
    // schema's input and output types stay identical.
    acceptTerms: z.boolean().refine((value) => value, {
      message: "Please accept the terms to continue.",
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  })
  .refine(
    (data) => {
      const local = data.email.split("@")[0] ?? "";
      return local.length < 4 || !data.password.toLowerCase().includes(local);
    },
    {
      message: "Your password must not contain your email address.",
      path: ["password"],
    },
  );

export type RegisterAccountInput = z.infer<typeof registerAccountSchema>;

// --- Registration: step 2, the business ------------------------------------

export const registerBusinessSchema = z
  .object({
    businessName: z
      .string()
      .trim()
      .min(2, "Enter your business name.")
      .max(160, "Business name is too long."),
    businessType: z.enum([
      "SOLE_PROPRIETORSHIP",
      "PARTNERSHIP",
      "LLP",
      "PRIVATE_LIMITED",
      "PUBLIC_LIMITED",
      "HUF",
      "OTHER",
    ]),
    gstRegistration: z.enum(["UNREGISTERED", "REGULAR", "COMPOSITION", "SEZ"]),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(GSTIN_PATTERN, "Enter a valid 15-character GSTIN.")
      .optional()
      .or(z.literal("")),
    pan: z
      .string()
      .trim()
      .toUpperCase()
      .regex(PAN_PATTERN, "Enter a valid 10-character PAN.")
      .optional()
      .or(z.literal("")),
    addressLine1: z
      .string()
      .trim()
      .min(3, "Enter your business address.")
      .max(200),
    city: z.string().trim().min(2, "Enter your city.").max(80),
    stateCode: z.string().trim().min(2, "Select your state."),
    pincode: z
      .string()
      .trim()
      .regex(PINCODE_PATTERN, "Enter a valid 6-digit PIN code."),
  })
  // A GST-registered business without a GSTIN cannot produce a valid tax
  // invoice, so the requirement is conditional rather than blanket.
  .refine(
    (data) =>
      data.gstRegistration === "UNREGISTERED" ||
      (data.gstin !== undefined && data.gstin !== ""),
    {
      message: "A GSTIN is required for a GST-registered business.",
      path: ["gstin"],
    },
  )
  .refine(
    (data) => {
      if (!data.gstin) return true;
      const code = gstinStateCode(data.gstin);
      return code === null || code === data.stateCode;
    },
    {
      message:
        "The state code in your GSTIN does not match the selected state.",
      path: ["gstin"],
    },
  )
  .refine(
    (data) => {
      if (!data.gstin || !data.pan) return true;
      const embedded = panFromGstin(data.gstin);
      return embedded === null || embedded === data.pan;
    },
    {
      message: "The PAN inside your GSTIN does not match the PAN entered.",
      path: ["pan"],
    },
  );

export type RegisterBusinessInput = z.infer<typeof registerBusinessSchema>;

// --- Registration: step 3, the books ---------------------------------------

/**
 * Every field is required with no `.default()` or `.coerce`, which keeps the
 * schema's input and output types identical. That matters because react-hook-form
 * types the form values from the input side and the submit handler from the
 * output side; a mismatch makes the resolver's generics unassignable. Initial
 * values are supplied by the form, and numeric coercion happens at the input.
 */
const openingAmount = (label: string) =>
  z
    .number({ error: `Enter a valid ${label}.` })
    .min(0, `${label} cannot be negative.`)
    .max(1_000_000_000, "Enter a smaller figure.");

export const registerAccountingSchema = z.object({
  /** 1-12. Determines when the fiscal year rolls over. */
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  currency: z.string().length(3),
  // Opening capital is deliberately NOT an input. It is derived as the sum of
  // the assets actually introduced, which is what makes the opening entry
  // balance by construction. A free-text capital figure that disagreed with
  // the listed assets would have to be reconciled to a suspense account, and a
  // mystery balance on day one is precisely the problem this product exists to
  // eliminate. Assets acquired before adoption are recorded later through
  // their own modules, each with its matching capital adjustment.
  openingCashBalance: openingAmount("Opening cash"),
  openingBankBalance: openingAmount("Opening bank balance"),
  inventoryMethod: z.enum(["FIFO", "WEIGHTED_AVERAGE"]),
  /** Seeds the tenant with the demo dataset instead of an empty ledger. */
  loadDemoData: z.boolean(),
});

export type RegisterAccountingInput = z.infer<typeof registerAccountingSchema>;

/** The complete payload the registration server action will receive. */
export const registerSchema = z.object({
  account: registerAccountSchema,
  business: registerBusinessSchema,
  accounting: registerAccountingSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;

// --- Password reset ---------------------------------------------------------

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, "This reset link is not valid."),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
