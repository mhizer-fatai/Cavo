-- Query indexes used by auth, wallet lookup, profiles, payments, PIN checks, and email OTP.
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
