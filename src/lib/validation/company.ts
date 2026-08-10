import { z } from "zod";
import {
  GSTIN_PATTERN,
  INDIAN_MOBILE_PATTERN,
  PAN_PATTERN,
  PINCODE_PATTERN,
  gstinStateCode,
  panFromGstin,
} from "@/lib/constants/india";

/**
 * Company settings schemas.
 *
 * Split by concern rather than presented as one giant form: the profile can be
 * edited freely at any time, while the accounting settings are constrained by
 * what has already been posted. Keeping them separate means the UI can gate
 * one without disabling the other.
 */

const optionalTrimmed = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal(""));

// --- Business profile -------------------------------------------------------

export const companyProfileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Enter your business name.")
      .max(160, "Business name is too long."),
    legalName: optionalTrimmed(160),
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
    addressLine1: z.string().trim().min(3, "Enter your address.").max(200),
    addressLine2: optionalTrimmed(200),
    city: z.string().trim().min(2, "Enter your city.").max(80),
    stateCode: z.string().trim().min(2, "Select your state."),
    pincode: z
      .string()
      .trim()
      .regex(PINCODE_PATTERN, "Enter a valid 6-digit PIN code."),
    phone: z
      .string()
      .trim()
      .regex(INDIAN_MOBILE_PATTERN, "Enter a valid 10-digit mobile number.")
      .optional()
      .or(z.literal("")),
    email: z.email("Enter a valid email address.").optional().or(z.literal("")),
    website: z.url("Enter a valid URL.").optional().or(z.literal("")),
  })
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

export type CompanyProfileInput = z.infer<typeof companyProfileSchema>;

// --- Accounting settings ----------------------------------------------------

/**
 * Which of these may change is decided at runtime by what has been posted, not
 * by the schema — the server checks and reports precisely why a field is
 * locked. See `describeAccountingLocks` in the settings service.
 */
export const companyAccountingSchema = z.object({
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  currency: z.string().length(3),
  inventoryMethod: z.enum(["FIFO", "WEIGHTED_AVERAGE"]),
  timezone: z.string().trim().min(1).max(64),
});

export type CompanyAccountingInput = z.infer<typeof companyAccountingSchema>;

// --- Branches ---------------------------------------------------------------

export const branchSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, "Enter a short code, e.g. MAIN or BLR2.")
    .max(12, "Keep the code to 12 characters or fewer.")
    .regex(/^[A-Z0-9-]+$/, "Use letters, numbers and hyphens only."),
  name: z.string().trim().min(2, "Enter a branch name.").max(120),
  addressLine1: optionalTrimmed(200),
  city: optionalTrimmed(80),
  stateCode: optionalTrimmed(2),
  pincode: z
    .string()
    .trim()
    .regex(PINCODE_PATTERN, "Enter a valid 6-digit PIN code.")
    .optional()
    .or(z.literal("")),
  phone: z
    .string()
    .trim()
    .regex(INDIAN_MOBILE_PATTERN, "Enter a valid 10-digit mobile number.")
    .optional()
    .or(z.literal("")),
});

export type BranchInput = z.infer<typeof branchSchema>;

// --- Team -------------------------------------------------------------------

export const inviteMemberSchema = z.object({
  email: z
    .email("Enter a valid email address.")
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  fullName: z.string().trim().min(2, "Enter their name.").max(120),
  roleId: z.string().min(1, "Choose a role."),
  /** Optional branch restriction, for cashiers and branch managers. */
  branchId: z.string().optional().or(z.literal("")),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const acceptInvitationSchema = z
  .object({
    token: z.string().min(1, "This invitation link is not valid."),
    fullName: z.string().trim().min(2, "Enter your full name.").max(120),
    mobile: z
      .string()
      .trim()
      .regex(INDIAN_MOBILE_PATTERN, "Enter a valid 10-digit mobile number.")
      .optional()
      .or(z.literal("")),
    password: z.string().min(10, "Use at least 10 characters."),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const changeMemberRoleSchema = z.object({
  membershipId: z.string().min(1),
  roleId: z.string().min(1, "Choose a role."),
  branchId: z.string().optional().or(z.literal("")),
});

export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema>;
