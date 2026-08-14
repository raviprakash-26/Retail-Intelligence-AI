-- A return is rounded to the rupee like every other document, and the
-- difference is posted to Round Off rather than absorbed into the value of the
-- goods. Without somewhere to keep it, a credit note's stored total could not
-- be reconciled to its own taxable value and tax.
ALTER TABLE "sales_returns"
  ADD COLUMN "roundOff" DECIMAL(18,4) NOT NULL DEFAULT 0;

ALTER TABLE "purchase_returns"
  ADD COLUMN "roundOff" DECIMAL(18,4) NOT NULL DEFAULT 0;
