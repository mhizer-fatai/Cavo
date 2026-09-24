-- Login identities and Circle developer-controlled Cavo wallets.
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
