-- Payroll: statutory deductions, and somewhere to put them.
--
-- Two changes, and the first is the reason for the second.
--
-- A payroll item carried one lump `deductions` figure. That is enough to work
-- out what an employee is paid and not enough to run a business: provident
-- fund goes to the EPFO, employee state insurance to the ESIC, professional
-- tax to the state and TDS to the income tax department, on four different due
-- dates. A single number cannot answer "how much do I owe the EPFO this
-- month", which is the question the deduction exists to raise. The components
-- are therefore stored beside the total rather than instead of it — the total
-- stays, so nothing that reads it breaks.
--
-- The employer's own PF and ESI contributions are on the item too. They are
-- not withheld from anybody; they are what the employee costs on top of the
-- gross, and a payslip that cannot show cost-to-company is missing the figure
-- an owner actually plans with.
ALTER TABLE "payroll_items"
  ADD COLUMN "employeeProvidentFund" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "employeeStateInsurance" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "professionalTax" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "taxDeductedAtSource" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "employerProvidentFund" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "employerStateInsurance" DECIMAL(18,4) NOT NULL DEFAULT 0;

ALTER TABLE "payroll"
  ADD COLUMN "employerContributions" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- Whether the establishment is covered by either scheme is a fact about the
-- business — headcount, registration, when it crossed the threshold — and
-- cannot be inferred from anything already stored. Both default to off, and
-- professional tax is null rather than guessed from the address: a plausible
-- wrong default is worse than an obviously absent one.
ALTER TABLE "companies"
  ADD COLUMN "providentFundApplicable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "esiApplicable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "professionalTaxMonthly" DECIMAL(18,4);

-- The three statutory liabilities and the employer-contribution expense, for
-- businesses that already exist. New ones get them from the chart at
-- provisioning; these are copied from a sibling account so the group, type,
-- nature and section are right by construction rather than by being retyped
-- into a migration.
INSERT INTO "accounts" (
  "id", "companyId", "groupId", "code", "name", "type", "subType", "nature",
  "section", "systemKey", "isSystem", "openingBalance", "openingNature",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), sibling."companyId", sibling."groupId", entry.code,
  entry.name, sibling."type", sibling."subType", sibling."nature",
  sibling."section", entry.system_key, true, 0, sibling."nature", now(), now()
FROM "accounts" sibling
CROSS JOIN (VALUES
  ('2133', 'PF Payable', 'PF_PAYABLE'),
  ('2134', 'ESI Payable', 'ESI_PAYABLE'),
  ('2135', 'Professional Tax Payable', 'PROFESSIONAL_TAX_PAYABLE')
) AS entry(code, name, system_key)
WHERE sibling."systemKey" = 'SALARY_PAYABLE'
  AND NOT EXISTS (
    SELECT 1 FROM "accounts" existing
    WHERE existing."companyId" = sibling."companyId"
      AND existing."systemKey" = entry.system_key
  );

INSERT INTO "accounts" (
  "id", "companyId", "groupId", "code", "name", "type", "subType", "nature",
  "section", "systemKey", "isSystem", "openingBalance", "openingNature",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), sibling."companyId", sibling."groupId", '6113',
  'Employer Contributions', sibling."type", sibling."subType",
  sibling."nature", sibling."section", 'EMPLOYER_CONTRIBUTIONS', true, 0,
  sibling."nature", now(), now()
FROM "accounts" sibling
WHERE sibling."systemKey" = 'SALARY_EXPENSE'
  AND NOT EXISTS (
    SELECT 1 FROM "accounts" existing
    WHERE existing."companyId" = sibling."companyId"
      AND existing."systemKey" = 'EMPLOYER_CONTRIBUTIONS'
  );
