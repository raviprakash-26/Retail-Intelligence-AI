import "server-only";
import { prisma } from "@/lib/db";
import { PERMISSIONS, type PermissionKey } from "@/lib/rbac/permissions";
import { recordAuditLog } from "@/server/audit/audit-log";

/**
 * Roles a business defines for itself.
 *
 * The pricing page has sold "Custom roles & permissions" as a Business-plan
 * feature since the beginning, and no such thing existed: there was no page, no
 * action, no service, and `roles.manage` appeared nowhere outside the
 * catalogue. Roles were seeded at signup from six system templates and could
 * never change. This is the feature the page was charging for.
 *
 * The machinery was already right for it. Authorization asks "may this member
 * do `sales.create`?" and never "is this member an accountant?", so a role is
 * only a named bundle of permissions — which means a business can invent one
 * without a line of code changing anywhere else.
 *
 * **Nobody can mint a role more powerful than themselves.** This is the whole
 * risk of the feature. A manager who can create roles and assign them could
 * otherwise build a role holding `billing.manage` and `users.manage`, give it
 * to themselves, and have quietly promoted themselves to owner. So a role may
 * only contain permissions the person building it already holds, and the same
 * rule applies to editing one. An owner holds everything and is unaffected;
 * everybody else can only ever delegate downwards.
 *
 * **System roles are readable and untouchable.** They are the templates every
 * company is seeded from, shared across tenants, and a business editing one
 * would be editing every business's.
 */

export class RoleError extends Error {
  constructor(
    message: string,
    readonly code:
      "NOT_FOUND" | "SYSTEM" | "IN_USE" | "ESCALATION" | "DUPLICATE",
  ) {
    super(message);
    this.name = "RoleError";
  }
}

export type RoleView = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: PermissionKey[];
  /** How many people currently hold it — a role in use cannot be removed. */
  members: number;
};

/** Every role this company can assign: the system templates and its own. */
export async function listRoles(companyId: string): Promise<RoleView[]> {
  const roles = await prisma.role.findMany({
    // Both, deliberately: a business assigns from the seeded templates and
    // from anything it has built, and a list showing only one is a list
    // somebody has to reconcile in their head.
    where: { OR: [{ companyId }, { companyId: null, isSystem: true }] },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      isSystem: true,
      companyId: true,
      permissions: { select: { permission: { select: { key: true } } } },
      _count: { select: { memberships: true } },
    },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });

  return roles.map((role) => ({
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: role.permissions.map(
      (entry) => entry.permission.key as PermissionKey,
    ),
    members: role._count.memberships,
  }));
}

/**
 * The permissions somebody may put into a role.
 *
 * Their own, and no more. Returned rather than merely checked so the page can
 * show only what is on offer — a list full of checkboxes that refuse to save
 * is a worse way to learn the rule than not showing them.
 */
export function grantableBy(
  holder: ReadonlySet<PermissionKey>,
): PermissionKey[] {
  return (Object.keys(PERMISSIONS) as PermissionKey[]).filter((key) =>
    holder.has(key),
  );
}

function assertNoEscalation(
  wanted: readonly PermissionKey[],
  holder: ReadonlySet<PermissionKey>,
): void {
  const beyond = wanted.filter((key) => !holder.has(key));
  if (beyond.length > 0) {
    throw new RoleError(
      `A role cannot be given ${beyond.length === 1 ? "a permission" : "permissions"} you do not hold yourself: ${beyond.join(", ")}.`,
      "ESCALATION",
    );
  }
}

/** Turns a name into the stable key the role is stored under. */
function keyOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 48) || "role"
  );
}

export async function createRole(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  holder: ReadonlySet<PermissionKey>;
  name: string;
  description?: string;
  permissions: readonly PermissionKey[];
}): Promise<RoleView> {
  const name = params.name.trim();
  if (name.length < 2) {
    throw new RoleError("Give the role a name.", "DUPLICATE");
  }
  if (params.permissions.length === 0) {
    throw new RoleError(
      "A role with no permissions grants nothing. Choose at least one.",
      "DUPLICATE",
    );
  }
  assertNoEscalation(params.permissions, params.holder);

  const key = keyOf(name);
  const clash = await prisma.role.findFirst({
    where: { companyId: params.companyId, key },
    select: { id: true },
  });
  if (clash) {
    throw new RoleError(`There is already a role called ${name}.`, "DUPLICATE");
  }

  const rows = await prisma.permission.findMany({
    where: { key: { in: [...params.permissions] } },
    select: { id: true },
  });

  const role = await prisma.role.create({
    data: {
      companyId: params.companyId,
      key,
      name,
      description: params.description?.trim() || null,
      isSystem: false,
      permissions: {
        createMany: { data: rows.map((row) => ({ permissionId: row.id })) },
      },
    },
    select: { id: true },
  });

  await recordAuditLog({
    action: "role.created",
    module: "Settings",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Role",
    entityId: role.id,
    metadata: { name, permissions: [...params.permissions] },
  });

  const all = await listRoles(params.companyId);
  return all.find((entry) => entry.id === role.id)!;
}

export async function updateRole(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  holder: ReadonlySet<PermissionKey>;
  roleId: string;
  name: string;
  description?: string;
  permissions: readonly PermissionKey[];
}): Promise<RoleView> {
  const role = await prisma.role.findFirst({
    where: { id: params.roleId, companyId: params.companyId },
    select: { id: true, isSystem: true, name: true },
  });
  // A system role has `companyId: null`, so it cannot match here — which is
  // the point. Asking for one by id finds nothing rather than editing a
  // template every other business is seeded from.
  if (!role) throw new RoleError("That role could not be found.", "NOT_FOUND");
  if (role.isSystem) {
    throw new RoleError("A built-in role cannot be changed.", "SYSTEM");
  }

  if (params.permissions.length === 0) {
    throw new RoleError(
      "A role with no permissions grants nothing. Choose at least one.",
      "DUPLICATE",
    );
  }
  assertNoEscalation(params.permissions, params.holder);

  const rows = await prisma.permission.findMany({
    where: { key: { in: [...params.permissions] } },
    select: { id: true },
  });

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
    prisma.role.update({
      where: { id: role.id },
      data: {
        name: params.name.trim(),
        description: params.description?.trim() || null,
        permissions: {
          createMany: { data: rows.map((row) => ({ permissionId: row.id })) },
        },
      },
    }),
  ]);

  await recordAuditLog({
    action: "role.updated",
    module: "Settings",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Role",
    entityId: role.id,
    metadata: {
      name: params.name.trim(),
      permissions: [...params.permissions],
    },
  });

  const all = await listRoles(params.companyId);
  return all.find((entry) => entry.id === role.id)!;
}

/**
 * Removes a role nobody holds.
 *
 * A role in use is refused rather than reassigned. Deciding on somebody's
 * behalf what they should have instead is not a decision this should make
 * quietly — the people holding it have to be moved first, deliberately.
 */
export async function deleteRole(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  roleId: string;
}): Promise<void> {
  const role = await prisma.role.findFirst({
    where: { id: params.roleId, companyId: params.companyId },
    select: {
      id: true,
      name: true,
      isSystem: true,
      _count: { select: { memberships: true } },
    },
  });
  if (!role) throw new RoleError("That role could not be found.", "NOT_FOUND");
  if (role.isSystem) {
    throw new RoleError("A built-in role cannot be removed.", "SYSTEM");
  }
  if (role._count.memberships > 0) {
    throw new RoleError(
      `${role._count.memberships} ${role._count.memberships === 1 ? "person holds" : "people hold"} this role. Move them to another one first.`,
      "IN_USE",
    );
  }

  await prisma.role.delete({ where: { id: role.id } });

  await recordAuditLog({
    action: "role.deleted",
    module: "Settings",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Role",
    entityId: role.id,
    metadata: { name: role.name },
  });
}
