-- Earn cross-chain withdrawals: bind the CCTP bridge destination into the
-- PIN approval so a bridge leg only runs when the approval covered it.
ALTER TABLE public.cavo_pin_approvals
  ADD COLUMN IF NOT EXISTS bridge_to TEXT;
ALTER TABLE public.cavo_pin_approvals
  ADD COLUMN IF NOT EXISTS bridge_address TEXT;
