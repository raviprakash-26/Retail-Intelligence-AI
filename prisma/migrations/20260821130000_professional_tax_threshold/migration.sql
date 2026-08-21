-- The wage above which professional tax is levied, which differs by state.
--
-- The monthly amount was already settable and this was not, so a business
-- outside Karnataka could say what it levied but not from what wage, and
-- Karnataka's 25,000 was applied to everybody. Null preserves exactly that,
-- so no existing tenant's payroll changes by a rupee.
ALTER TABLE "companies"
  ADD COLUMN "professionalTaxThreshold" DECIMAL(18,4);
