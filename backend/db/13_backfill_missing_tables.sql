-- Backfill for existing Cavo databases that never ran the base migrations
-- (00-09). Creates only the missing tables — idempotent, safe to re-run,
-- never drops or modifies existing rows. Includes the optional approval
-- bridge-destination columns (supersedes 12_bridge_binding.sql).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Payment PINs.
CREATE TABLE IF NOT EXISTS public.cavo_pins (
  user_key TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  recovery_question TEXT,
  recovery_answer_hash TEXT,
  recovery_answer_salt TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  recovery_failed_attempts INTEGER NOT NULL DEFAULT 0,
  recovery_locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS cavo_pins_set_updated_at ON public.cavo_pins;
CREATE TRIGGER cavo_pins_set_updated_at
BEFORE UPDATE ON public.cavo_pins
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- One-time transaction approvals (with optional bridge-destination columns).
CREATE TABLE IF NOT EXISTS public.cavo_pin_approvals (
  id UUID PRIMARY KEY,
  user_key TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  destination_chain TEXT NOT NULL DEFAULT 'Arc_Testnet',
  amount TEXT NOT NULL,
  token TEXT NOT NULL DEFAULT 'USDC',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bridge_to TEXT,
  bridge_address TEXT
);

-- Security audit events.
CREATE TABLE IF NOT EXISTS public.cavo_security_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  user_key TEXT,
  wallet_address TEXT,
  destination_address TEXT,
  amount TEXT,
  token TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Short-lived hashed 6-digit email login codes.
CREATE TABLE IF NOT EXISTS public.email_login_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_login_codes_attempt_count_check
    CHECK (attempt_count >= 0)
);

-- Stablecoin swap ledger (USDC <-> EURC).
CREATE TABLE IF NOT EXISTS public.swaps (
  id UUID PRIMARY KEY,
  user_key TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_in NUMERIC NOT NULL,
  amount_out NUMERIC,
  min_out NUMERIC,
  provider TEXT NOT NULL DEFAULT 'circle',
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  quote JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT swaps_token_in_check
    CHECK (token_in IN ('USDC', 'EURC')),
  CONSTRAINT swaps_token_out_check
    CHECK (token_out IN ('USDC', 'EURC')),
  CONSTRAINT swaps_tokens_differ_check
    CHECK (token_in <> token_out),
  CONSTRAINT swaps_status_check
    CHECK (status IN ('pending', 'completed', 'failed'))
);

DROP TRIGGER IF EXISTS swaps_set_updated_at ON public.swaps;
CREATE TRIGGER swaps_set_updated_at
BEFORE UPDATE ON public.swaps
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- Indexes.
CREATE INDEX IF NOT EXISTS idx_cavo_pin_approvals_user_key
  ON public.cavo_pin_approvals (user_key);
CREATE INDEX IF NOT EXISTS idx_cavo_pin_approvals_expires_at
  ON public.cavo_pin_approvals (expires_at);
CREATE INDEX IF NOT EXISTS idx_cavo_security_events_user_key
  ON public.cavo_security_events (user_key);
CREATE INDEX IF NOT EXISTS idx_cavo_security_events_created_at
  ON public.cavo_security_events (created_at);
CREATE INDEX IF NOT EXISTS swaps_user_key_created_at_idx ON public.swaps (user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS swaps_wallet_address_idx ON public.swaps (wallet_address);
CREATE INDEX IF NOT EXISTS swaps_tx_hash_idx ON public.swaps (tx_hash);

-- Row level security (backend accesses these via the service role key).
ALTER TABLE public.cavo_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cavo_pin_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cavo_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.swaps ENABLE ROW LEVEL SECURITY;
