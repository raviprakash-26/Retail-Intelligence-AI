-- Bring every existing company's system roles back into line with the
-- templates they were copied from.
--
-- Provisioning copies the template's rows at signup and nothing afterwards
-- revisited them, so a permission added in a later release reached the
-- templates and no tenant already in existence. The Owner template carries
-- `permissions: null`, documented as every permission "including ones added in
-- future releases" — true of the template, false of every company. An owner
-- who signed up before the data export shipped could not export their own
-- books, while their role still read "Full access to every module".
--
-- Safe in both directions because a company's system roles are copies and
-- nothing else: a tenant cannot edit one (updateRole and deleteRole both
-- refuse isSystem), so any difference from the template is drift rather than a
-- choice somebody made.
--
-- The seed performs the same sync on every run from now on, which is what
-- keeps the next release's permissions from stopping at the templates. This
-- migration is the one-time catch-up for everything provisioned before it.

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
ON CONFLICT DO NOTHING;

DELETE FROM "role_permissions" AS stale
USING "roles" AS company_role
WHERE stale."roleId" = company_role."id"
  AND company_role."companyId" IS NOT NULL
  AND company_role."isSystem"
  AND NOT EXISTS (
    SELECT 1
    FROM "roles" AS template
    JOIN "role_permissions" AS template_grant
      ON template_grant."roleId" = template."id"
    WHERE template."companyId" IS NULL
      AND template."isSystem"
      AND template."key" = company_role."key"
      AND template_grant."permissionId" = stale."permissionId"
  );
