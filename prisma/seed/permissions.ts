import type { PrismaClient } from "@prisma/client";
import {
  PERMISSIONS,
  SYSTEM_ROLE_TEMPLATES,
  permissionsForRole,
} from "@/lib/rbac/permissions";
import { reconcileCompanyChart } from "@/server/provisioning/chart-reconciler";
import { withPlatformSeedLock } from "./lock";

/**
 * Seeds the global permission catalogue and the system role templates, then
 * brings every company's copies back into line with them.
 *
 * These are platform-level rows, not tenant data: `Role.companyId` is NULL for
 * templates, and each new company is provisioned by copying them. Running this
 * repeatedly is safe — it upserts, so adding a permission in a later release
 * is a matter of re-running the seed.
 *
 * **Re-running it was not enough on its own.** Provisioning copies the
 * template's rows at signup, and nothing afterwards revisited them: a later
 * release updated the templates and every company already in existence kept
 * the set it was given the day it signed up. The Owner template says
 * `permissions: null`, documented as every permission "including ones added in
 * future releases", and that was true of the template and false of every
 * tenant — an owner who signed up before the data export shipped could not
 * export their own books, while their role still read "Full access to every
 * module".
 *
 * A company's system roles are copies and nothing else. A tenant cannot edit
 * one — `updateRole` and `deleteRole` both refuse `isSystem` — so any
 * difference from the template is drift rather than a choice somebody made,
 * and the sync below removes as well as adds.
 */
export type SeedPermissionsOptions = {
  /**
   * Whether to bring companies that already exist up to date with the
   * templates.
   *
   * `"sync"` on a deployment, which is the point of `syncExistingTenants` — a
   * release that adds a permission has to reach the tenants provisioned before
   * it. `"skip"` from the test suite, where it is both useless and harmful.
   *
   * Useless because every company a test uses was provisioned by `registerOwner`
   * from the templates a moment earlier, so there is no drift to repair — and
   * the sweep walks every company left in the database, so it grows with the
   * suite.
   *
   * Harmful because the sweep rewrites the role permissions of companies it did
   * not create. `withPlatformSeedLock` serialises the template half against
   * another copy of itself, "and in CI there is always another copy of itself";
   * the sweep runs outside that lock by design. Vitest gives each worker its
   * own module registry, so each one runs this once — and a worker seeding
   * while another test had deliberately dropped a permission put it straight
   * back, three statements before the assertion that it was gone. That is what
   * made `system-role-drift` fail about once in every few full runs, always on
   * a different key, never on its own.
   */
  existingTenants?: "sync" | "skip";
};

export async function seedPermissionsAndRoles(
  prisma: PrismaClient,
  options: SeedPermissionsOptions = {},
) {
  const entries = Object.entries(PERMISSIONS);

  // Serialised: read-then-write is not safe against another copy of itself,
  // and in CI there is always another copy of itself.
  const templates = await withPlatformSeedLock(prisma, async (tx) => {
    for (const [key, meta] of entries) {
      await tx.permission.upsert({
        where: { key },
        create: { key, module: meta.module, description: meta.description },
        update: { module: meta.module, description: meta.description },
      });
    }

    const permissionIds = new Map(
      (await tx.permission.findMany({ select: { id: true, key: true } })).map(
        (permission) => [permission.key, permission.id],
      ),
    );

    for (const template of SYSTEM_ROLE_TEMPLATES) {
      // Not an upsert: the @@unique([companyId, key]) constraint does not bind
      // template rows, because PostgreSQL treats NULL companyIds as distinct.
      // Uniqueness for templates is guaranteed by a partial unique index
      // (see migration 20260809073000_system_role_uniqueness); the lookup below
      // is what makes the seed idempotent.
      const existing = await tx.role.findFirst({
        where: { companyId: null, key: template.key },
        select: { id: true },
      });

      const role = existing
        ? await tx.role.update({
            where: { id: existing.id },
            data: { name: template.name, description: template.description },
          })
        : await tx.role.create({
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
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });

      const keys = permissionsForRole(template);
      await tx.rolePermission.createMany({
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
  });

  if (options.existingTenants === "skip") {
    return { ...templates, granted: 0, revoked: 0, groups: 0, accounts: 0 };
  }

  const tenants = await syncExistingTenants(prisma);
  return { ...templates, ...tenants };
}

/**
 * Brings every existing tenant up to date with the templates just written.
 *
 * Both halves of what provisioning copies: the system roles, and the chart of
 * accounts, which was never revisited either — the accounts the payroll
 * release introduced reached no existing tenant, and posting a run threw
 * `MissingAccountError` for every one of them.
 *
 * **Outside the seed's transaction, and one tenant at a time.** A company can
 * be deleted while this runs, and then a statement that read a role id a
 * moment earlier fails on a foreign key. Inside the transaction that is fatal
 * rather than skippable: Postgres aborts the whole transaction and every later
 * statement returns 25P02, so catching the error and continuing repairs
 * nothing. This is how the first version arrived, taking unrelated test suites
 * down with it and then, once the catch was added, taking them down more
 * confusingly.
 *
 * Each company is independent and each sync is idempotent, so none of this
 * needs to be atomic with the template maintenance — only to happen after it.
 * A tenant that disappears mid-flight is skipped, because a deleted company
 * needs nothing.
 */
async function syncExistingTenants(prisma: PrismaClient) {
  const companies = await prisma.company.findMany({ select: { id: true } });
  let granted = 0;
  let revoked = 0;
  let groups = 0;
  let accounts = 0;

  for (const company of companies) {
    try {
      const roles = await syncCompanySystemRoles(prisma, company.id);
      const chart = await reconcileCompanyChart(prisma, company.id);
      granted += roles.granted;
      revoked += roles.revoked;
      groups += chart.groups;
      accounts += chart.accounts;
    } catch (error) {
      if (isVanishedRow(error)) continue;
      throw error;
    }
  }

  return { synced: { granted, revoked }, chart: { groups, accounts } };
}

/**
 * Whether a failure is "the row is no longer there".
 *
 * Postgres 23503 is a foreign key violation and Prisma's P2003 and P2025 are
 * its own spellings of the same situation. Narrow deliberately: anything else
 * is a real fault and must not be swallowed by a loop meant to tolerate a
 * deleted tenant.
 */
function isVanishedRow(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "P2003" || code === "P2025") return true;
  const meta = (error as { meta?: { code?: string } } | null)?.meta;
  return meta?.code === "23503" || String(code) === "23503";
}

/**
 * Makes every company's system roles match the template of the same key.
 *
 * Set-based rather than a loop over companies: this runs on every deploy, and
 * the work is proportional to the number of tenants.
 *
 * Both halves are needed. The additions are what carry a new permission to
 * companies that already exist; the deletions are what make a permission
 * removed from a template actually leave the tenants holding it, which the
 * cascade only handles when the permission itself is deleted rather than
 * merely dropped from a role.
 */
export async function syncCompanySystemRoles(
  tx: Pick<PrismaClient, "$executeRaw">,
  /** One company, or every company when omitted, as the deploy does. */
  companyId?: string,
): Promise<{ granted: number; revoked: number }> {
  const granted = await tx.$executeRaw`
    INSERT INTO "role_permissions" ("roleId", "permissionId")
    SELECT company_role.id, template_grant."permissionId"
    FROM "roles" AS company_role
    JOIN "roles" AS template
      ON template."companyId" IS NULL
     AND template."isSystem"
     AND template."key" = company_role."key"
    JOIN "role_permissions" AS template_grant
      ON template_grant."roleId" = template."id"
    WHERE company_role."companyId" IS NOT NULL
      AND company_role."isSystem"
      AND (${companyId ?? null}::uuid IS NULL
           OR company_role."companyId" = ${companyId ?? null}::uuid)
    ON CONFLICT DO NOTHING
  `;

  const revoked = await tx.$executeRaw`
    DELETE FROM "role_permissions" AS stale
    USING "roles" AS company_role
    WHERE stale."roleId" = company_role."id"
      AND company_role."companyId" IS NOT NULL
      AND company_role."isSystem"
      AND (${companyId ?? null}::uuid IS NULL
           OR company_role."companyId" = ${companyId ?? null}::uuid)
      AND NOT EXISTS (
        SELECT 1
        FROM "roles" AS template
        JOIN "role_permissions" AS template_grant
          ON template_grant."roleId" = template."id"
        WHERE template."companyId" IS NULL
          AND template."isSystem"
          AND template."key" = company_role."key"
          AND template_grant."permissionId" = stale."permissionId"
      )
  `;

  return { granted, revoked };
}
