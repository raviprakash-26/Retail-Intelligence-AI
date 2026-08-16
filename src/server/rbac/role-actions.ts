"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FEATURE } from "@/lib/billing/plans";
import { PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { fail, ok, type ActionResult } from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { billingRefusal } from "@/server/billing/guards";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  createRole,
  deleteRole,
  updateRole,
  RoleError,
  type RoleView,
} from "./role-service";

/**
 * Building a role.
 *
 * Two gates, and they answer different questions. `roles.manage` asks whether
 * this person may do it; the plan gate asks whether this business has bought
 * it. Custom roles are what the pricing page sells as a Business-plan feature,
 * so the second check is what makes that sentence true rather than decorative.
 *
 * The permissions a role may hold are bounded by the permissions the person
 * building it holds — enforced in the service, because a check that lives only
 * in an action is a check a second caller skips.
 */

const permissionKey = z.enum(
  Object.keys(PERMISSIONS) as [PermissionKey, ...PermissionKey[]],
);

const createSchema = z.object({
  name: z.string().trim().min(2, "Give the role a name.").max(60),
  description: z.string().trim().max(200).optional().or(z.literal("")),
  permissions: z.array(permissionKey).min(1, "Choose at least one permission."),
});

const updateSchema = createSchema.extend({
  roleId: z.string().min(1),
});

const deleteSchema = z.object({ roleId: z.string().min(1) });

async function guard() {
  const context = await assertPermission("roles.manage");
  const refusal = await billingRefusal(context.company.id, {
    feature: FEATURE.ADVANCED_PERMISSIONS,
  });
  return { context, refusal };
}

export async function createRoleAction(
  input: unknown,
): Promise<ActionResult<RoleView>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const { context, refusal } = await guard();
  if (refusal) return refusal;

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "That role could not be created.",
    );
  }

  try {
    const role = await createRole({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      holder: context.permissions,
      name: parsed.data.name,
      description: parsed.data.description || undefined,
      permissions: parsed.data.permissions,
    });
    revalidatePath("/app/settings/roles");
    return ok(role);
  } catch (error) {
    if (error instanceof RoleError) return fail(error.message);
    throw error;
  }
}

export async function updateRoleAction(
  input: unknown,
): Promise<ActionResult<RoleView>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const { context, refusal } = await guard();
  if (refusal) return refusal;

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "That role could not be changed.",
    );
  }

  try {
    const role = await updateRole({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      holder: context.permissions,
      roleId: parsed.data.roleId,
      name: parsed.data.name,
      description: parsed.data.description || undefined,
      permissions: parsed.data.permissions,
    });
    revalidatePath("/app/settings/roles");
    return ok(role);
  } catch (error) {
    if (error instanceof RoleError) return fail(error.message);
    throw error;
  }
}

export async function deleteRoleAction(
  input: unknown,
): Promise<ActionResult<{ removed: true }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const { context, refusal } = await guard();
  if (refusal) return refusal;

  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return fail("That role could not be removed.");

  try {
    await deleteRole({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      roleId: parsed.data.roleId,
    });
    revalidatePath("/app/settings/roles");
    return ok({ removed: true as const });
  } catch (error) {
    if (error instanceof RoleError) return fail(error.message);
    throw error;
  }
}
