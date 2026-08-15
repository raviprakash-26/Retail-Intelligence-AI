-- Bank reconciliation.
--
-- The bank_accounts and bank_transactions tables have existed since the first
-- migration and nothing has ever written to them. This adds what reconciling
-- actually needs: a fingerprint that makes re-importing an overlapping
-- statement range a no-op, and a real foreign key for the match.

-- --------------------------------------------------------------------------
-- Fingerprints
-- --------------------------------------------------------------------------
-- Added nullable and backfilled before being made NOT NULL, so the migration
-- is safe against a table that turns out not to be empty after all. Any legacy
-- row is fingerprinted with its own id: we cannot reconstruct what its
-- statement line looked like, and a unique value means it neither collides
-- with a future import nor blocks one.
ALTER TABLE "bank_transactions" ADD COLUMN "fingerprint" TEXT;

UPDATE "bank_transactions" SET "fingerprint" = "id"::text WHERE "fingerprint" IS NULL;

ALTER TABLE "bank_transactions" ALTER COLUMN "fingerprint" SET NOT NULL;

-- The importer also checks for duplicates before inserting, but two people
-- uploading the same statement at the same moment would both read an empty
-- set and both write. Only the database can settle that.
CREATE UNIQUE INDEX "bank_transactions_bankAccountId_fingerprint_key"
  ON "bank_transactions" ("bankAccountId", "fingerprint");

-- --------------------------------------------------------------------------
-- The match
-- --------------------------------------------------------------------------
-- journalEntryId has been a bare uuid column with nothing enforcing that it
-- points at a journal entry that exists. A reconciliation whose match points
-- at nothing is worse than one that was never made.
ALTER TABLE "bank_transactions"
  ADD CONSTRAINT "bank_transactions_journalEntryId_fkey"
  FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "bank_transactions_journalEntryId_idx"
  ON "bank_transactions" ("journalEntryId");
