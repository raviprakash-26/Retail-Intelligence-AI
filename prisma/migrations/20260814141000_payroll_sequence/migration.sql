-- A numbered series for payroll runs.
--
-- Every other document in this product draws its number from a locked sequence
-- row so the series is gap-free, and a payroll run is a document like any
-- other. New companies get the sequence from the provisioner; existing ones
-- get it here, once per fiscal year, copied from the sale series so the
-- padding and the fiscal-year scoping match what the tenant already has.
INSERT INTO "document_sequences" (
  "id", "companyId", "fiscalYearId", "key", "prefix", "suffix", "padding",
  "nextValue", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), sale."companyId", sale."fiscalYearId", 'PAYROLL', 'SAL-',
  sale."suffix", sale."padding", 1, now(), now()
FROM "document_sequences" sale
WHERE sale."key" = 'SALE'
  AND NOT EXISTS (
    SELECT 1 FROM "document_sequences" existing
    WHERE existing."companyId" = sale."companyId"
      AND existing."key" = 'PAYROLL'
      AND existing."fiscalYearId" IS NOT DISTINCT FROM sale."fiscalYearId"
  );
