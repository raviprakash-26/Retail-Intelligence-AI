-- Eight permissions that reached no authorization check anywhere.
--
-- Granting one did nothing and withholding one protected nothing. They stayed
-- harmless while the catalogue was invisible; custom roles put it on a screen
-- with each description beside a checkbox, so they became capabilities offered
-- to a paying customer and not delivered.
--
--   sales.edit, purchases.edit, expenses.edit
--     "Edit draft sales invoices" and its two siblings. There are no drafts:
--     documents post immediately and are corrected by voiding and reissuing.
--
--   gst.prepare, tax.prepare
--     A preparing-versus-viewing split in two modules that have no actions at
--     all. Both are read-only working papers computed from recorded entries;
--     filing happens on the government portal. The Accountant and Tax
--     Consultant roles carried these to mean something the product never did.
--
--   gst.settings
--     "Change tax configuration". No such screen exists — rates are seeded at
--     provisioning and are not editable.
--
--   audit.view, audit.resolve
--     The auditor page is gated on ai.auditor, and it makes observations
--     rather than findings anybody resolves or dismisses.
--
-- role_permissions cascades from permissions, so the grants go with the rows.
-- Nothing is lost: no code path ever read any of them.

DELETE FROM "permissions"
WHERE "key" IN (
  'sales.edit',
  'purchases.edit',
  'expenses.edit',
  'gst.prepare',
  'gst.settings',
  'tax.prepare',
  'audit.view',
  'audit.resolve'
);
