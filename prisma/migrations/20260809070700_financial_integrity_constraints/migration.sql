-- =============================================================================
-- Financial integrity constraints
-- =============================================================================
-- These rules are enforced by PostgreSQL rather than only by application code.
-- A bug in a service, a bad migration, a manual psql session or a future
-- module cannot produce an unbalanced ledger while these are in place.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Journal lines: one-sided, non-negative
-- -----------------------------------------------------------------------------
-- A line posts to exactly one side. Both-zero lines are meaningless noise in a
-- ledger; both-non-zero lines hide a netting error.
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amounts_non_negative"
  CHECK ("debit" >= 0 AND "credit" >= 0);

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_single_sided"
  CHECK (("debit" = 0) <> ("credit" = 0));


-- -----------------------------------------------------------------------------
-- 2. Journal entries: control totals
-- -----------------------------------------------------------------------------
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_totals_non_negative"
  CHECK ("totalDebit" >= 0 AND "totalCredit" >= 0);

-- A draft may be mid-construction, but anything POSTED or REVERSED must balance.
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_balanced_when_posted"
  CHECK (
    "status" NOT IN ('POSTED', 'REVERSED')
    OR "totalDebit" = "totalCredit"
  );

-- A posted entry must carry the audit stamp that says who posted it and when.
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_posted_requires_timestamp"
  CHECK ("status" <> 'POSTED' OR "postedAt" IS NOT NULL);

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_void_requires_reason"
  CHECK ("status" <> 'VOIDED' OR ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL));


-- -----------------------------------------------------------------------------
-- 3. Journal lines must agree with their entry's control totals
-- -----------------------------------------------------------------------------
-- Deferred to COMMIT so the engine can insert the entry and its lines in any
-- order inside one transaction and still be checked as a unit.
CREATE OR REPLACE FUNCTION assert_journal_entry_balanced()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_entry_id   UUID;
  v_status     TEXT;
  v_sum_debit  NUMERIC(18, 4);
  v_sum_credit NUMERIC(18, 4);
  v_tot_debit  NUMERIC(18, 4);
  v_tot_credit NUMERIC(18, 4);
  v_line_count INTEGER;
BEGIN
  v_entry_id := COALESCE(NEW."id", OLD."id");

  SELECT "status"::TEXT, "totalDebit", "totalCredit"
    INTO v_status, v_tot_debit, v_tot_credit
    FROM "journal_entries"
   WHERE "id" = v_entry_id;

  -- Entry was deleted later in the same transaction; nothing to assert.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Drafts are allowed to be incomplete while a user is still editing them.
  IF v_status NOT IN ('POSTED', 'REVERSED') THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0)
    INTO v_line_count, v_sum_debit, v_sum_credit
    FROM "journal_lines"
   WHERE "journalEntryId" = v_entry_id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION
      'Journal entry % is % but has % line(s); double entry requires at least two.',
      v_entry_id, v_status, v_line_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_sum_debit <> v_sum_credit THEN
    RAISE EXCEPTION
      'Journal entry % does not balance: debits %, credits %.',
      v_entry_id, v_sum_debit, v_sum_credit
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_sum_debit <> v_tot_debit OR v_sum_credit <> v_tot_credit THEN
    RAISE EXCEPTION
      'Journal entry % control totals (%, %) disagree with its lines (%, %).',
      v_entry_id, v_tot_debit, v_tot_credit, v_sum_debit, v_sum_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "journal_entries_balance_check"
  AFTER INSERT OR UPDATE ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_journal_entry_balanced();


-- -----------------------------------------------------------------------------
-- 4. Posted journal entries and their lines are immutable
-- -----------------------------------------------------------------------------
-- Corrections happen through a reversing entry, never by editing history.
-- The only mutation allowed on a POSTED entry is the transition to VOIDED or
-- REVERSED, which is itself recorded with a timestamp and a reason.
CREATE OR REPLACE FUNCTION forbid_posted_journal_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
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

  -- Allowed lifecycle transitions out of POSTED.
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

CREATE TRIGGER "journal_entries_immutability"
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW
  EXECUTE FUNCTION forbid_posted_journal_mutation();

CREATE OR REPLACE FUNCTION forbid_posted_journal_line_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_entry_status TEXT;
  v_entry_id     UUID;
BEGIN
  v_entry_id := COALESCE(NEW."journalEntryId", OLD."journalEntryId");

  SELECT "status"::TEXT INTO v_entry_status
    FROM "journal_entries" WHERE "id" = v_entry_id;

  -- Parent already gone (cascade delete of a draft entry, or of a company).
  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_entry_status <> 'DRAFT' THEN
    -- Mirroring the parent's status onto the line is the one permitted update.
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

CREATE TRIGGER "journal_lines_immutability"
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW
  EXECUTE FUNCTION forbid_posted_journal_line_mutation();


-- -----------------------------------------------------------------------------
-- 5. Audit log is append-only
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION forbid_audit_log_mutation();


-- -----------------------------------------------------------------------------
-- 6. Document-level sanity checks
-- -----------------------------------------------------------------------------
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_amounts_non_negative"
  CHECK ("subTotal" >= 0 AND "taxableAmount" >= 0 AND "totalAmount" >= 0 AND "paidAmount" >= 0);

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_paid_not_over_total"
  CHECK ("paidAmount" <= "totalAmount");

ALTER TABLE "purchases"
  ADD CONSTRAINT "purchases_amounts_non_negative"
  CHECK ("subTotal" >= 0 AND "taxableAmount" >= 0 AND "totalAmount" >= 0 AND "paidAmount" >= 0);

ALTER TABLE "purchases"
  ADD CONSTRAINT "purchases_paid_not_over_total"
  CHECK ("paidAmount" <= "totalAmount");

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_quantity_positive"
  CHECK ("quantity" > 0 AND "rate" >= 0);

ALTER TABLE "purchase_items"
  ADD CONSTRAINT "purchase_items_quantity_positive"
  CHECK ("quantity" > 0 AND "rate" >= 0);

ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_amount_positive"
  CHECK ("amount" > 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive"
  CHECK ("amount" > 0);

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_amount_positive"
  CHECK ("amount" > 0 AND "totalAmount" > 0);

-- A stock movement of zero quantity carries no information and would corrupt
-- weighted-average cost recalculation with a divide-by-zero.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_quantity_non_zero"
  CHECK ("quantity" <> 0);

ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_percentages_valid"
  CHECK (
    "ratePercent" >= 0 AND "ratePercent" <= 100
    AND "cgstPercent" >= 0 AND "sgstPercent" >= 0
    AND "igstPercent" >= 0 AND "cessPercent" >= 0
  );

-- Intra-state tax splits into CGST + SGST; inter-state uses IGST. Whichever
-- form is configured, the components must reconstruct the headline rate.
ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_components_reconcile"
  CHECK (
    "cgstPercent" + "sgstPercent" = "ratePercent"
    OR "igstPercent" = "ratePercent"
  );

ALTER TABLE "fiscal_years"
  ADD CONSTRAINT "fiscal_years_date_order"
  CHECK ("startDate" < "endDate");

ALTER TABLE "fiscal_periods"
  ADD CONSTRAINT "fiscal_periods_date_order"
  CHECK ("startDate" <= "endDate");

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_fiscal_start_month_valid"
  CHECK ("fiscalYearStartMonth" BETWEEN 1 AND 12);

ALTER TABLE "gst_periods"
  ADD CONSTRAINT "gst_periods_month_valid"
  CHECK ("periodMonth" BETWEEN 1 AND 12);

ALTER TABLE "gst_transactions"
  ADD CONSTRAINT "gst_transactions_month_valid"
  CHECK ("periodMonth" BETWEEN 1 AND 12);

ALTER TABLE "audit_runs"
  ADD CONSTRAINT "audit_runs_score_range"
  CHECK ("score" BETWEEN 0 AND 100);


-- -----------------------------------------------------------------------------
-- 7. Partial indexes for the hot reporting paths
-- -----------------------------------------------------------------------------
-- Ledger, trial balance and every statement read only POSTED lines. A partial
-- index keeps drafts and voided entries out of the scan entirely.
CREATE INDEX "journal_lines_posted_ledger_idx"
  ON "journal_lines" ("companyId", "accountId", "entryDate")
  WHERE "status" = 'POSTED';

CREATE INDEX "journal_lines_posted_party_idx"
  ON "journal_lines" ("companyId", "partyType", "partyId", "entryDate")
  WHERE "status" = 'POSTED' AND "partyId" IS NOT NULL;

CREATE INDEX "sales_posted_idx"
  ON "sales" ("companyId", "invoiceDate")
  WHERE "status" = 'POSTED';

CREATE INDEX "purchases_posted_idx"
  ON "purchases" ("companyId", "billDate")
  WHERE "status" = 'POSTED';

CREATE INDEX "expenses_posted_idx"
  ON "expenses" ("companyId", "expenseDate")
  WHERE "status" = 'POSTED';

-- Outstanding receivables/payables queries.
CREATE INDEX "sales_outstanding_idx"
  ON "sales" ("companyId", "customerId")
  WHERE "status" = 'POSTED' AND "paidAmount" < "totalAmount";

CREATE INDEX "purchases_outstanding_idx"
  ON "purchases" ("companyId", "supplierId")
  WHERE "status" = 'POSTED' AND "paidAmount" < "totalAmount";

-- Low-stock alerting.
CREATE INDEX "products_active_stock_tracked_idx"
  ON "products" ("companyId")
  WHERE "isActive" = true AND "isStockTracked" = true;

-- Unread notification badge.
CREATE INDEX "notifications_unread_idx"
  ON "notifications" ("companyId", "userId", "createdAt")
  WHERE "readAt" IS NULL;

-- Session lookup only ever cares about live sessions.
CREATE INDEX "sessions_active_idx"
  ON "sessions" ("userId", "expiresAt")
  WHERE "revokedAt" IS NULL;

-- Only one fiscal year per company may be marked current.
CREATE UNIQUE INDEX "fiscal_years_one_current_per_company"
  ON "fiscal_years" ("companyId")
  WHERE "isCurrent" = true;

-- Only one primary branch per company.
CREATE UNIQUE INDEX "branches_one_primary_per_company"
  ON "branches" ("companyId")
  WHERE "isPrimary" = true;
