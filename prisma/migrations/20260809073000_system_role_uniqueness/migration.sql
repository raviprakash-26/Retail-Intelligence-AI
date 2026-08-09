-- Roles are unique per company via @@unique([companyId, key]). PostgreSQL
-- treats NULLs as distinct in unique constraints, so that constraint does not
-- constrain the system role *templates*, which carry companyId IS NULL.
-- A partial unique index closes the gap and lets the seed upsert them safely.
CREATE UNIQUE INDEX "roles_system_template_key_unique"
  ON "roles" ("key")
  WHERE "companyId" IS NULL;
