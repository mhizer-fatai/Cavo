-- Lock all tables behind RLS. The backend uses SUPABASE_SERVICE_ROLE_KEY for access.
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
