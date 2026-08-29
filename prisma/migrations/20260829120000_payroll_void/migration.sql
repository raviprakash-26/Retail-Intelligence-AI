-- One *live* payroll run per period, rather than one row per period ever.
--
-- `createPayrollRun` has always refused a period that already has a run, and has
-- always made an exception for a cancelled one: `duplicate.status !== CANCELLED`
-- is what lets a month be run again after a mistake. Nothing ever set CANCELLED,
-- so the exception was unreachable — and had it been reached, the insert behind
-- it would have failed anyway. A plain unique index on the period does not care
-- what the old row's status is, so the second run would have been rejected by
-- the database with a constraint error rather than the sentence the guard was
-- written to produce.
--
-- Partial, the way `fiscal_years_one_current_per_company` and
-- `branches_one_primary_per_company` are: the rule is about the live row, so the
-- index is too. A cancelled run stays in the table, keeps its reference and its
-- payslips, and stops standing in the way of the run that replaces it.
DROP INDEX IF EXISTS "payroll_companyId_periodYear_periodMonth_key";

CREATE UNIQUE INDEX "payroll_one_live_run_per_period"
  ON "payroll" ("companyId", "periodYear", "periodMonth")
  WHERE "status" <> 'CANCELLED';
