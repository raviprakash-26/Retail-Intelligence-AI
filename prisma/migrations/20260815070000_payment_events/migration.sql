-- Payment gateway integration.
--
-- One new table, and an index on the column an incoming webhook looks an
-- invoice up by.

-- --------------------------------------------------------------------------
-- What the provider told us
-- --------------------------------------------------------------------------
CREATE TABLE "payment_events" (
  "id"                UUID         NOT NULL,
  "provider"          TEXT         NOT NULL,
  "eventId"           TEXT         NOT NULL,
  "eventType"         TEXT         NOT NULL,
  "signatureVerified" BOOLEAN      NOT NULL DEFAULT false,
  "payload"           JSONB        NOT NULL,
  "processedAt"       TIMESTAMP(3),
  "outcome"           TEXT,
  "invoiceId"         UUID,
  "companyId"         UUID,
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- The whole idempotency story. Providers retry deliveries by design, so the
-- second arrival of an event must be a no-op rather than a second upgrade —
-- and only a unique index can promise that against two workers racing.
CREATE UNIQUE INDEX "payment_events_provider_eventId_key"
  ON "payment_events" ("provider", "eventId");

CREATE INDEX "payment_events_provider_eventType_receivedAt_idx"
  ON "payment_events" ("provider", "eventType", "receivedAt");

CREATE INDEX "payment_events_companyId_receivedAt_idx"
  ON "payment_events" ("companyId", "receivedAt");

-- --------------------------------------------------------------------------
-- Append-only
-- --------------------------------------------------------------------------
-- The same treatment audit_logs gets, for the same reason: this table is the
-- record of what a third party told us about money, and a record that can be
-- edited after the fact is not evidence of anything. `processedAt` and
-- `outcome` are written by the handler, so an UPDATE that only fills those in
-- is allowed; changing what the provider said is not.
CREATE OR REPLACE FUNCTION "payment_events_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_financial_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payment_events is append-only: rows cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF current_setting('app.allow_financial_purge', true) = 'on' THEN
      RETURN NEW;
    END IF;
    IF NEW."provider"   IS DISTINCT FROM OLD."provider"
    OR NEW."eventId"    IS DISTINCT FROM OLD."eventId"
    OR NEW."eventType"  IS DISTINCT FROM OLD."eventType"
    OR NEW."payload"    IS DISTINCT FROM OLD."payload"
    OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
    OR NEW."signatureVerified" IS DISTINCT FROM OLD."signatureVerified" THEN
      RAISE EXCEPTION 'payment_events is append-only: what the provider sent cannot be changed';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payment_events_append_only"
  BEFORE UPDATE OR DELETE ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION "payment_events_append_only"();

-- --------------------------------------------------------------------------
-- Finding the invoice a webhook is about
-- --------------------------------------------------------------------------
-- A webhook names the provider's order id and nothing of ours, so this is the
-- lookup on the hot path of every payment.
CREATE INDEX "subscription_invoices_providerInvoiceId_idx"
  ON "subscription_invoices" ("providerInvoiceId");

-- --------------------------------------------------------------------------
-- Which plan an invoice was raised to buy
-- --------------------------------------------------------------------------
-- Recorded when the checkout opens, so the webhook grants the plan somebody
-- actually chose. Inferring it from the amount would break the day two plans
-- are priced the same — and would break silently, by upgrading to the wrong
-- one.
ALTER TABLE "subscription_invoices" ADD COLUMN "targetPlanId" UUID;

ALTER TABLE "subscription_invoices"
  ADD CONSTRAINT "subscription_invoices_targetPlanId_fkey"
  FOREIGN KEY ("targetPlanId") REFERENCES "subscription_plans"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "subscription_invoices_targetPlanId_idx"
  ON "subscription_invoices" ("targetPlanId");
