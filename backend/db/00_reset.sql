-- Drops all Cavo tables/functions so the schema can be recreated cleanly.
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
