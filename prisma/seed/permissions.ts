import type { PrismaClient } from "@prisma/client";
import {
  PERMISSIONS,
  SYSTEM_ROLE_TEMPLATES,
  permissionsForRole,
} from "@/lib/rbac/permissions";

/**
 * Seeds the global permission catalogue and the system role templates.
 *
 * These are platform-level rows, not tenant data: `Role.companyId` is NULL for
 * templates, and each new company is provisioned by copying them. Running this
 * repeatedly is safe — it upserts, so adding a permission in a later release
 * is a matter of re-running the seed.
 */
export async function seedPermissionsAndRoles(prisma: PrismaClient) {
  const entries = Object.entries(PERMISSIONS);

  for (const [key, meta] of entries) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, module: meta.module, description: meta.description },
      update: { module: meta.module, description: meta.description },
    });
  }

  const permissionIds = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map(
      (permission) => [permission.key, permission.id],
    ),
  );

  for (const template of SYSTEM_ROLE_TEMPLATES) {
    // Not an upsert: the @@unique([companyId, key]) constraint does not bind
    // template rows, because PostgreSQL treats NULL companyIds as distinct.
    // Uniqueness for templates is guaranteed by a partial unique index
    // (see migration 20260809073000_system_role_uniqueness); the lookup below
    // is what makes the seed idempotent.
    const existing = await prisma.role.findFirst({
      where: { companyId: null, key: template.key },
      select: { id: true },
    });

    const role = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: template.name, description: template.description },
        })
      : await prisma.role.create({
          data: {
            companyId: null,
            key: template.key,
            name: template.name,
            description: template.description,
            isSystem: true,
          },
        });

    // Replace rather than merge: a permission removed from a template in code
    // must actually be revoked, not linger on the seeded row.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });

    const keys = permissionsForRole(template);
    await prisma.rolePermission.createMany({
      data: keys
        .map((key) => permissionIds.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }

  return {
    permissions: entries.length,
    roles: SYSTEM_ROLE_TEMPLATES.length,
  };
}
