import { z } from "zod";
import { isoDate } from "@/lib/validation/date";

/**
 * What a payroll run and its policy are allowed to say.
 *
 * The run carries a period, a pay date and — per employee — a TDS figure and
 * nothing else. Salaries are read from the employee records on the server, so
 * the browser can say *when* people are paid and how much tax was withheld,
 * and cannot say what anybody earns.
 */

export const payrollPolicySchema = z.object({
  providentFund: z.boolean(),
  employeeStateInsurance: z.boolean(),
  /** Null where the state levies none, or the business has not said. */
  professionalTaxMonthly: z
    .number()
    .min(0, "Professional tax cannot be negative.")
    .max(10_000, "That looks too large for a monthly figure.")
    .nullable(),
  /**
   * The wage above which it is levied. Null keeps Karnataka's, which is where
   * a business that set only the amount already sat.
   */
  professionalTaxThreshold: z
    .number()
    .min(0, "A threshold cannot be negative.")
    .max(10_00_000, "That looks too large for a monthly wage.")
    .nullable()
    .optional(),
});

export const payrollRunSchema = z.object({
  year: z
    .number()
    .int()
    .min(2000, "That year is too far back.")
    .max(2100, "That year is too far ahead."),
  month: z.number().int().min(1, "Pick a month.").max(12, "Pick a month."),
  payDate: isoDate,
  /**
   * Employee id → tax withheld. Absent means nil, which is the honest default
   * for a figure this platform does not compute.
   */
  taxDeducted: z
    .record(
      z.string().uuid(),
      z
        .number()
        .min(0, "Tax withheld cannot be negative.")
        .max(99_99_999, "That figure looks too large."),
    )
    .optional(),
});

/** Why a run is being cancelled. As the other voids: a reason is required. */
export const voidPayrollSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "Say why this payroll run is being cancelled.")
    .max(300, "Keep the reason under 300 characters."),
});

export type VoidPayrollInput = z.infer<typeof voidPayrollSchema>;
export type PayrollPolicyInput = z.infer<typeof payrollPolicySchema>;
export type PayrollRunInput = z.infer<typeof payrollRunSchema>;
