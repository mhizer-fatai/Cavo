-- Public Cavo usernames and their receiving wallets.
CREATE TABLE public.profiles (
  username TEXT PRIMARY KEY,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  owner_address TEXT NOT NULL UNIQUE,
  wallet_address TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
