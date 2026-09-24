-- Mainnet session security: refresh-token rotation, token revocation,
-- request idempotency, and an append-only audit log.
-- Pairs with backend/services/sessions.js.

-- One row per issued refresh token. The raw token is never stored;
-- only its SHA-256 hash. Rotation inserts a new row and revokes the old one.
CREATE TABLE IF NOT EXISTS public.cavo_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  user_key TEXT NOT NULL,
  auth_provider TEXT NOT NULL DEFAULT 'email',
  provider_user_id TEXT,
  email TEXT,
  refresh_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refresh_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS cavo_sessions_user_idx
  ON public.cavo_sessions (user_key);
CREATE INDEX IF NOT EXISTS cavo_sessions_refresh_hash_idx
  ON public.cavo_sessions (refresh_hash);

-- Denylist for access-token jtis (logout / ticket consumption / compromise).
-- Rows are only meaningful until expires_at, then they can be purged.
CREATE TABLE IF NOT EXISTS public.cavo_revoked_jti (
  jti TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'revoked',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency keys for money-movement POSTs. A replayed key returns the
-- stored response instead of executing the operation again.
CREATE TABLE IF NOT EXISTS public.api_idempotency (
  key TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  response JSONB NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 200,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_idempotency_user_idx
  ON public.api_idempotency (user_key);

-- Earn positions (user vault shares + principal).
CREATE TABLE IF NOT EXISTS public.earn_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  token TEXT NOT NULL,
  vault TEXT NOT NULL,
  shares NUMERIC(30,6) NOT NULL DEFAULT 0,
  principal NUMERIC(30,6) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_earn_positions_user_key
  ON public.earn_positions (user_key);

-- Earn events (deposits, withdrawals, bridge activity).
CREATE TABLE IF NOT EXISTS public.earn_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  token TEXT,
  vault TEXT,
  amount NUMERIC(30,6),
  destination_chain TEXT,
  destination_address TEXT,
  bridge_tx_hash TEXT,
  outcome TEXT NOT NULL DEFAULT 'ok',
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_earn_events_user_key
  ON public.earn_events (user_key);
CREATE INDEX IF NOT EXISTS idx_earn_events_kind
  ON public.earn_events (kind);

-- Earn vault snapshots (share price at recorded timestamps).
CREATE TABLE IF NOT EXISTS public.earn_vault_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault TEXT NOT NULL,
  share_price NUMERIC(30,18) NOT NULL,
  total_assets NUMERIC(30,18) NOT NULL,
  total_supply NUMERIC(30,18) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_earn_vault_snapshots_vault
  ON public.earn_vault_snapshots (vault);

-- Append-only security audit log. Nothing updates or deletes these rows.
CREATE TABLE IF NOT EXISTS public.cavo_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'ok',
  ip TEXT,
  user_agent TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cavo_audit_log_user_idx
  ON public.cavo_audit_log (user_key);
CREATE INDEX IF NOT EXISTS cavo_audit_log_action_idx
  ON public.cavo_audit_log (action);
