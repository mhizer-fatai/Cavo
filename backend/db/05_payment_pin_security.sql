-- Cavo payment PINs, one-time transaction approvals, and security audit events.
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bridge_to TEXT,
  bridge_address TEXT
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
