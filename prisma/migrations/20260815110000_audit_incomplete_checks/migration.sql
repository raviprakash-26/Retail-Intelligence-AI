-- Checks that could not be completed on a run.
--
-- Previously this was computed, returned once, and forgotten: the page that
-- triggered the audit showed which checks had failed, and every later view of
-- the same run showed a score with no indication that part of the sweep never
-- ran. A score presented as complete when it is not is the one thing an audit
-- feature must not do, so the caveat is now stored beside the number it
-- qualifies.
--
-- Existing rows default to an empty array, which is the correct reading of
-- them: runs made before this column existed have no record of a failure, and
-- claiming otherwise retrospectively would be inventing history.
ALTER TABLE "audit_runs"
  ADD COLUMN "incompleteChecks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
