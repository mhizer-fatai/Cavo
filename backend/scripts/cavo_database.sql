-- Cavo full database schema.
-- This file is the Supabase SQL editor entrypoint.
-- The same schema is split into smaller files under backend/db for maintainability.

-- 00_reset.sql
DROP TABLE IF EXISTS public.cavo_security_events CASCADE;
DROP TABLE IF EXISTS public.swaps CASCADE;
DROP TABLE IF EXISTS public.cavo_pin_approvals CASCADE;
DROP TABLE IF EXISTS public.cavo_pins CASCADE;
DROP TABLE IF EXISTS public.email_login_codes CASCADE;
DROP TABLE IF EXISTS public.shield_events CASCADE;
DROP TABLE IF EXISTS public.payments CASCADE;
DROP TABLE IF EXISTS public.payment_links CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;
DROP TABLE IF EXISTS public.user_wallets CASCADE;
DROP TABLE IF EXISTS public.accounts CASCADE;

DROP FUNCTION IF EXISTS public.set_updated_at() CASCADE;

-- 01_extensions_and_functions.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 02_accounts_and_wallets.sql
CREATE TABLE public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auth_provider, provider_user_id)
);

DROP TRIGGER IF EXISTS accounts_set_updated_at ON public.accounts;

CREATE TRIGGER accounts_set_updated_at
BEFORE UPDATE ON public.accounts
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.user_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  user_address TEXT NOT NULL UNIQUE,
  wallet_address TEXT NOT NULL UNIQUE,
  circle_wallet_id TEXT NOT NULL UNIQUE,
  circle_wallet_set_id TEXT,
  wallet_type TEXT NOT NULL DEFAULT 'developer_controlled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_wallets_wallet_type_check
    CHECK (wallet_type = 'developer_controlled')
);

DROP TRIGGER IF EXISTS user_wallets_set_updated_at ON public.user_wallets;

CREATE TRIGGER user_wallets_set_updated_at
BEFORE UPDATE ON public.user_wallets
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- 03_profiles.sql
CREATE TABLE public.profiles (
  username TEXT PRIMARY KEY,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  owner_address TEXT NOT NULL UNIQUE,
  wallet_address TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 04_payments_and_links.sql
CREATE TABLE public.payment_links (
  id UUID PRIMARY KEY,
  creator_address TEXT NOT NULL,
  amount NUMERIC,
  token TEXT NOT NULL DEFAULT 'USDC',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT payment_links_token_check
    CHECK (token IN ('USDC', 'EURC'))
);

CREATE TABLE public.payments (
  id UUID PRIMARY KEY,
  link_id UUID REFERENCES public.payment_links(id) ON DELETE SET NULL,
  payer_address TEXT NOT NULL,
  recipient_address TEXT,
  source_chain TEXT NOT NULL DEFAULT 'Arc_Testnet',
  destination_chain TEXT NOT NULL DEFAULT 'Arc_Testnet',
  tx_hash TEXT NOT NULL UNIQUE,
  amount NUMERIC,
  token TEXT NOT NULL DEFAULT 'USDC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payments_token_check
    CHECK (token IN ('USDC', 'EURC'))
);

-- 05_payment_pin_security.sql
CREATE TABLE public.cavo_pins (
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

CREATE TABLE public.cavo_pin_approvals (
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.cavo_security_events (
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

-- 06_email_login_codes.sql
CREATE TABLE public.email_login_codes (
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

-- 07_indexes.sql
CREATE INDEX idx_accounts_provider_user
  ON public.accounts (auth_provider, provider_user_id);

CREATE INDEX idx_user_wallets_account_id
  ON public.user_wallets (account_id);

CREATE INDEX idx_user_wallets_user_address
  ON public.user_wallets (user_address);

CREATE INDEX idx_user_wallets_wallet_address
  ON public.user_wallets (wallet_address);

CREATE INDEX idx_profiles_account_id
  ON public.profiles (account_id);

CREATE INDEX idx_profiles_owner_wallet
  ON public.profiles (owner_address);

CREATE INDEX idx_profiles_cavo_wallet
  ON public.profiles (wallet_address);

CREATE INDEX idx_payment_links_creator
  ON public.payment_links (creator_address);

CREATE INDEX idx_payment_links_expires_at
  ON public.payment_links (expires_at);

CREATE INDEX idx_payments_payer
  ON public.payments (payer_address);

CREATE INDEX idx_payments_recipient
  ON public.payments (recipient_address);

CREATE INDEX idx_payments_destination_chain
  ON public.payments (destination_chain);

CREATE INDEX idx_payments_source_chain
  ON public.payments (source_chain);

CREATE INDEX idx_payments_link
  ON public.payments (link_id);

CREATE INDEX idx_cavo_pin_approvals_user_key
  ON public.cavo_pin_approvals (user_key);

CREATE INDEX idx_cavo_pin_approvals_expires_at
  ON public.cavo_pin_approvals (expires_at);

CREATE INDEX idx_cavo_security_events_user_key
  ON public.cavo_security_events (user_key);

CREATE INDEX idx_cavo_security_events_created_at
  ON public.cavo_security_events (created_at);

CREATE INDEX idx_email_login_codes_email
  ON public.email_login_codes (email);

CREATE INDEX idx_email_login_codes_expires_at
  ON public.email_login_codes (expires_at);

-- 08_row_level_security.sql
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cavo_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cavo_pin_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cavo_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_login_codes ENABLE ROW LEVEL SECURITY;

-- No public RLS policies are created here on purpose.
-- Cavo reads and writes these tables through the backend using SUPABASE_SERVICE_ROLE_KEY.
-- Browser clients with the anon key should not directly access wallet, PIN, approval, OTP, or ledger data.

-- 09_swaps.sql
CREATE TABLE public.swaps (
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

CREATE INDEX swaps_user_key_created_at_idx ON public.swaps (user_key, created_at DESC);
CREATE INDEX swaps_wallet_address_idx ON public.swaps (wallet_address);
CREATE INDEX swaps_tx_hash_idx ON public.swaps (tx_hash);

ALTER TABLE public.swaps ENABLE ROW LEVEL SECURITY;
