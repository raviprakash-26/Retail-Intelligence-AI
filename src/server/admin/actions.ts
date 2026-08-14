"use server";

import { revalidatePath } from "next/cache";
import { CompanyStatus } from "@prisma/client";
import {
  ACTION_ERROR,
  fail,
  ok,
  type ActionResult,
} from "@/server/auth/action-result";
import { requirePlatformAdmin } from "@/server/auth/context";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  setCompanyStatus,
  setEntitlementOverride,
  updatePlan,
} from "@/server/admin/admin-service";

/**
 * The things an administrator can change.
 *
 * Every one of them re-checks the platform role on the server: the admin area
 * is behind a layout that checks too, but a layout is a rendering decision and
 * these are actions anybody could post to directly.
 *
 * There is deliberately no action here that reads a tenant's records. The panel
 * cannot show them, and an action that fetched them would be the same
 * disclosure through a different door.
 */

const STATUSES: Record<string, CompanyStatus> = {
  ACTIVE: CompanyStatus.ACTIVE,
  SUSPENDED: CompanyStatus.SUSPENDED,
  CANCELLED: CompanyStatus.CANCELLED,
};

export async function setCompanyStatusAction(
  companyId: string,
  status: string,
  reason?: string,
): Promise<ActionResult<{ status: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const session = await requirePlatformAdmin();
  const next = STATUSES[status];
  if (!next) {
    return fail("That is not a status an account can be put into.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  const done = await setCompanyStatus({
    companyId,
    status: next,
    adminId: session.user.id,
    adminEmail: session.user.email,
    reason: reason?.trim() || undefined,
  });

  if (!done) {
    return fail("That business could not be found.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  revalidatePath("/admin/tenants");
  revalidatePath(`/admin/tenants/${companyId}`);
  return ok({ status });
}

export async function setFeatureOverrideAction(
  companyId: string,
  feature: string,
  granted: boolean | null,
  current: Record<string, boolean>,
): Promise<ActionResult<{ overrides: Record<string, boolean> }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const session = await requirePlatformAdmin();

  // null clears the override, putting the business back on whatever its plan
  // says — the state it would have been in had nobody intervened.
  const overrides = { ...current };
  if (granted === null) delete overrides[feature];
  else overrides[feature] = granted;

  const done = await setEntitlementOverride({
    companyId,
    featureOverrides: overrides,
    adminId: session.user.id,
    adminEmail: session.user.email,
  });

  if (!done) {
    return fail("That business has no subscription to change.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  revalidatePath(`/admin/tenants/${companyId}`);
  return ok({ overrides });
}

export async function updatePlanAction(
  planId: string,
  input: { name?: string; priceMinor?: number; isPublic?: boolean },
): Promise<ActionResult<{ planId: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const session = await requirePlatformAdmin();

  if (input.priceMinor !== undefined && input.priceMinor < 0) {
    return fail("A price cannot be negative.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  const done = await updatePlan({
    planId,
    ...input,
    adminId: session.user.id,
    adminEmail: session.user.email,
  });

  if (!done) {
    return fail("That plan could not be found.", {
      code: ACTION_ERROR.INVALID_INPUT,
    });
  }

  revalidatePath("/admin/plans");
  return ok({ planId });
}
