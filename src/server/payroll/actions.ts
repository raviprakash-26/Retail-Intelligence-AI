"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  payrollPolicySchema,
  payrollRunSchema,
  type PayrollPolicyInput,
  type PayrollRunInput,
} from "@/lib/validation/payroll";
import { logger } from "@/lib/observability/logger";
import { recordActionFailure } from "@/lib/observability/metrics";
import {
  ACTION_ERROR,
  fail,
  ok,
  zodFieldErrors,
  type ActionResult,
} from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { billingRefusal } from "@/server/billing/guards";
import {
  NoFiscalPeriodError,
  PeriodClosedError,
} from "@/server/accounting/post-journal-entry";
import { requireSameOrigin } from "@/server/security/request-context";
import { recordAuditLog } from "@/server/audit/audit-log";
import {
  createPayrollRun,
  PayrollError,
  type PostedPayroll,
} from "@/server/payroll/payroll-service";

/**
 * Payroll actions.
 *
 * The form sends a period, a pay date and a tax figure per employee. It never
 * sends a salary — those are read from the employee records — so an altered
 * request can change when staff are paid but not what they are owed.
 */

function revalidatePayroll(): void {
  for (const path of ["/app", "/app/payroll", "/app/employees"]) {
    revalidatePath(path);
  }
}

function fromServiceError(error: unknown): ActionResult<never> {
  if (error instanceof PayrollError) {
    return fail(error.message, { code: error.code });
  }
  if (
    error instanceof PeriodClosedError ||
    error instanceof NoFiscalPeriodError
  ) {
    return fail(error.message, { code: "PERIOD_UNAVAILABLE" });
  }
  logger.error("Payroll action failed", { module: "Payroll", error });
  recordActionFailure("Payroll", ACTION_ERROR.UNEXPECTED);
  return fail("Something went wrong. Nothing was posted — please try again.", {
    code: ACTION_ERROR.UNEXPECTED,
  });
}

export async function runPayrollAction(
  input: PayrollRunInput,
): Promise<ActionResult<PostedPayroll>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("payroll.manage");

  const refusal = await billingRefusal(context.company.id, {
    limit: "transactionsPerMonth",
  });
  if (refusal) return refusal;

  const parsed = payrollRunSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the run below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await createPayrollRun({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      branchId: context.membership.branchId,
      year: parsed.data.year,
      month: parsed.data.month,
      payDate: parsed.data.payDate,
      taxDeducted: parsed.data.taxDeducted,
    });
    revalidatePayroll();
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}

/**
 * Whether the establishment is covered by each scheme.
 *
 * Facts about the business rather than a preference, which is why they are
 * recorded rather than inferred — and why changing them is a payroll
 * permission and written to the audit log. Switching PF on changes what every
 * future payslip withholds.
 */
export async function updatePayrollPolicyAction(
  input: PayrollPolicyInput,
): Promise<ActionResult<PayrollPolicyInput>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("payroll.manage");

  const parsed = payrollPolicySchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the settings below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  await prisma.company.update({
    where: { id: context.company.id },
    data: {
      providentFundApplicable: parsed.data.providentFund,
      esiApplicable: parsed.data.employeeStateInsurance,
      professionalTaxMonthly: parsed.data.professionalTaxMonthly,
      professionalTaxThreshold: parsed.data.professionalTaxThreshold ?? null,
    },
  });

  await recordAuditLog({
    action: "payroll.policy.updated",
    module: "Payroll",
    companyId: context.company.id,
    userId: context.user.id,
    actorEmail: context.user.email,
    entityType: "Company",
    entityId: context.company.id,
    metadata: {
      providentFund: parsed.data.providentFund,
      employeeStateInsurance: parsed.data.employeeStateInsurance,
      professionalTaxMonthly: parsed.data.professionalTaxMonthly,
      professionalTaxThreshold: parsed.data.professionalTaxThreshold ?? null,
    },
  });

  revalidatePayroll();
  return ok(parsed.data);
}
