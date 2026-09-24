-- One-off migration for existing databases:
-- renames the legacy payme_* tables to the cavo_* names used by the current schema.
-- Fresh installs do not need this file (the base schema already creates cavo_* tables).

ALTER TABLE IF EXISTS public.payme_pin_approvals RENAME TO cavo_pin_approvals;
ALTER TABLE IF EXISTS public.payme_pins RENAME TO cavo_pins;
ALTER TABLE IF EXISTS public.payme_security_events RENAME TO cavo_security_events;

ALTER INDEX IF EXISTS idx_payme_pin_approvals_user_key RENAME TO idx_cavo_pin_approvals_user_key;
ALTER INDEX IF EXISTS idx_payme_pin_approvals_expires_at RENAME TO idx_cavo_pin_approvals_expires_at;
ALTER INDEX IF EXISTS idx_payme_security_events_user_key RENAME TO idx_cavo_security_events_user_key;
ALTER INDEX IF EXISTS idx_payme_security_events_created_at RENAME TO idx_cavo_security_events_created_at;
