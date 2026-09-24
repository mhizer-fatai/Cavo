-- Stablecoin swap ledger (USDC <-> EURC) executed through swap providers.
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
