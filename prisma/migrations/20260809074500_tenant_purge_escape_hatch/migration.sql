-- =============================================================================
-- Tenant purge escape hatch
-- =============================================================================
-- The immutability triggers correctly refuse to delete a POSTED journal entry,
-- including when the delete arrives as a cascade from `companies`. That is the
-- desired behaviour for every ordinary code path.
--
-- But a tenant must still be erasable — a customer exercising a data-deletion
-- right, and the demo tenant being reset, both require it. Rather than weaken
-- the triggers, deletion is gated behind a transaction-scoped flag that a
-- caller has to set deliberately:
--
--     SET LOCAL app.allow_financial_purge = 'on';
--     DELETE FROM companies WHERE id = $1;
--
-- `SET LOCAL` means the permission dies with the transaction, so it cannot
-- leak into an unrelated statement on a pooled connection.
-- =============================================================================

CREATE OR REPLACE FUNCTION financial_purge_allowed()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN COALESCE(current_setting('app.allow_financial_purge', true), 'off') = 'on';
END;
$$;

CREATE OR REPLACE FUNCTION forbid_posted_journal_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' AND NOT financial_purge_allowed() THEN
      RAISE EXCEPTION
        'Journal entry % is % and cannot be deleted; reverse or void it instead.',
        OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'POSTED' AND NEW."status" IN ('VOIDED', 'REVERSED') THEN
    IF NEW."totalDebit" <> OLD."totalDebit"
       OR NEW."totalCredit" <> OLD."totalCredit"
       OR NEW."entryDate" <> OLD."entryDate"
       OR NEW."companyId" <> OLD."companyId" THEN
      RAISE EXCEPTION
        'Journal entry % may change status only; financial fields are immutable once posted.',
        OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" <> OLD."status"
     OR NEW."totalDebit" <> OLD."totalDebit"
     OR NEW."totalCredit" <> OLD."totalCredit"
     OR NEW."entryDate" <> OLD."entryDate"
     OR NEW."companyId" <> OLD."companyId"
     OR NEW."entryNumber" <> OLD."entryNumber" THEN
    RAISE EXCEPTION
      'Journal entry % is % and its financial fields are immutable.',
      OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION forbid_posted_journal_line_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_entry_status TEXT;
  v_entry_id     UUID;
BEGIN
  IF TG_OP = 'DELETE' AND financial_purge_allowed() THEN
    RETURN OLD;
  END IF;

  v_entry_id := COALESCE(NEW."journalEntryId", OLD."journalEntryId");

  SELECT "status"::TEXT INTO v_entry_status
    FROM "journal_entries" WHERE "id" = v_entry_id;

  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_entry_status <> 'DRAFT' THEN
    IF TG_OP = 'UPDATE'
       AND NEW."debit" = OLD."debit"
       AND NEW."credit" = OLD."credit"
       AND NEW."accountId" = OLD."accountId"
       AND NEW."entryDate" = OLD."entryDate"
       AND NEW."companyId" = OLD."companyId" THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'Journal line % belongs to a % entry and cannot be modified.',
      COALESCE(NEW."id", OLD."id"), v_entry_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- The audit log is append-only for the same reasons, and erasable under the
-- same deliberate flag.
CREATE OR REPLACE FUNCTION forbid_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND financial_purge_allowed() THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- audit_logs.companyId is ON DELETE SET NULL, so purging a company would
-- otherwise leave orphaned rows *and* trip the append-only UPDATE guard.
-- Allow that specific nulling only during a purge.
CREATE OR REPLACE FUNCTION forbid_audit_log_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF financial_purge_allowed() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only; UPDATE is not permitted.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "audit_logs_append_only" ON "audit_logs";

CREATE TRIGGER "audit_logs_no_delete"
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION forbid_audit_log_mutation();

CREATE TRIGGER "audit_logs_no_update"
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION forbid_audit_log_update();
