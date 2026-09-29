# Cavo — Stablecoin Payments on Arc

Cavo is a stablecoin payments app on **Arc** for sending, receiving, swapping, earning, and withdrawing USDC and EURC — through usernames, payment links, and QR codes, with Web2-style onboarding (Google / email OTP, no seed phrases). Built for creators, freelancers, and small businesses.

> **Live demo:** <https://your-frontend-url> *(fill in after deploy)*
> **Mainnet contract:** `0x…` *(fill in after deploy, verify on [explorer.arc.io](https://explorer.arc.io))*

---

## Features

- **Web2 onboarding** — Google OAuth or 6-digit email OTP. No seed phrases, no browser extension required.
- **Circle dev-controlled wallets** — a managed wallet is created for every account; the app signs through Circle APIs.
- **`@username` handles** — claimable payment handles with QR codes (`/u/:username`).
- **Payment links** — shareable expiring checkout links (`/pay/:linkId`), settled on-chain through the `Cavo` router contract with a platform fee.
- **Send** — direct USDC/EURC transfers to addresses or usernames, gated by a 4-digit Payment PIN.
- **Swap** — USDC ↔ EURC quotes with server-side slippage floors (Circle + Tower providers).
- **Earn** — ERC-4626 vault deposits with share-price-tracked yield and Arc-settled withdrawals.
- **Withdraw** — CCTP cross-chain withdrawals to any address on supported chains.
- **History, contacts, favorites, transaction tracking, session management.**

---

## Architecture

```
frontend (React + Vite, :3000) ──/api──▶ backend (Express, :3001)
                                          ├─▶ Supabase Postgres (sessions, PINs, ledger, earn)
                                          ├─▶ Circle APIs (wallets, CCTP, swaps, Earn Kit)
                                          └─▶ Arc RPC (balances, receipts, vault reads)
contracts (Solidity, Hardhat) ──deployed──▶ Arc (Cavo payment router)
```

---

## Tech stack

| Layer    | Stack                                                                                 |
| -------- | ------------------------------------------------------------------------------------- |
| Frontend | React 19, Vite, TypeScript, React Router, Wagmi, Viem, Lucide, `qrcode.react`         |
| Backend  | Node.js, Express, Supabase (`supabase-js`), Circle SDKs (app-kit, earn-kit, adapters), Zod, Helmet, `express-rate-limit` |
| Contracts| Solidity `^0.8.20`, Hardhat, OpenZeppelin (`Ownable`, `Pausable`, `ReentrancyGuard`) |
| Data     | Supabase Postgres with row-level security; numbered SQL migrations in `backend/db`    |

---

## Quick start

Prerequisites: Node.js 22+, a Supabase project, a Circle developer account (API key + entity secret).

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env   # then fill in the values below
npm run dev            # nodemon on :3001 (first boot is slow: Circle SDK load)
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev            # Vite on :3000, proxies /api → :3001
```

### 3. Contracts

```bash
cd contracts
npm install
npx hardhat compile
npx hardhat run scripts/deploy.js --network arc_testnet   # needs DEPLOYER_PRIVATE_KEY + Arc USDC for gas
```

### 4. Database

Run the migrations in order in the Supabase SQL editor (all idempotent):

`00_reset` (⚠️ destructive — fresh installs only) → `01` → `02` → `03` → `04` → `05` → `06` → `07` → `08` → `09` → `10` (legacy renames only) → `11_security` → `12_bridge_binding` → `13_backfill_missing_tables`

Or run the combined script `backend/scripts/cavo_database.sql` (same SQL, same order). Databases that missed the base migrations can run just `13_backfill_missing_tables.sql`.

---

## Environment variables

### Backend (`backend/.env`)

| Variable | Purpose |
| -------- | ------- |
| `PORT` | API port (default `3001`) |
| `NODE_ENV` | Set `production` on mainnet deploys (Secure cookies, strict rate limits, quiet errors) |
| `FRONTEND_URL` | Exact frontend origin for CORS (e.g. `https://app.example.com`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project + service-role key (bypasses RLS; server-side only) |
| `CAVO_SESSION_SECRET` | JWT signing secret (min 32 chars, fail-closed if missing) |
| `CAVO_PIN_PEPPER` | Pepper for PIN/recovery-answer hashes (min 32 chars) |
| `EMAIL_CODE_SECRET` (or `OTP_PEPPER`) | HMAC secret for login codes |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | SMTP sender for OTP emails |
| `GOOGLE_CLIENT_ID` | Google OAuth client (server-side verification) |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | Circle dev wallets + signing |
| `CIRCLE_KIT_KEY` | Circle App-Kit key (`KIT_KEY:<id>:<secret>`) for swaps |
| `ARC_NETWORK` | `testnet` (default) or `mainnet` — flips chain ID, SDK chain name, RPC, explorer, and token defaults |
| `ARC_RPC_URL` | Primary Arc RPC endpoint (per-network default) |
| `ARC_EXPLORER_URL` | Block explorer base (per-network default) |
| `ARCSCAN_API_BASE` | Arcscan-compatible API base for the balance proxy |
| `ARC_USDC_ADDRESS`, `ARC_EURC_ADDRESS` | Token contracts (per-network defaults; mainnet EURC verified on explorer) |
| `EARN_ALVUSDC_VAULT`, `EARN_ALVEURC_VAULT`, `EARN_MAX_PER_TX` | Earn vaults + per-tx cap |
| `SWAP_PROVIDER` | `circle` (default) or `tower` |
| `SWAP_SLIPPAGE_BPS`, `TOWER_API_BASE`, `TOWER_API_KEY`, `TOWER_SLIPPAGE_BPS` | Swap config |
| `CAVO_MAX_SINGLE_SEND_USDC`, `CAVO_MAX_DAILY_SEND_USDC` | Spending limits |
| `OTP_EXPIRES_MINUTES`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_COOLDOWN_SECONDS` | Login-code policy |
| `MAX_ACTIVE_LINKS` | Payment-link anti-spam cap (default 50) |

### Frontend (`frontend/.env`)

| Variable | Purpose |
| -------- | ------- |
| `VITE_BACKEND_URL` | Backend base (`/api` for the Vite proxy, full URL in production) |
| `VITE_CAVO_CONTRACT_ADDRESS` | Deployed `Cavo` router (falls back to the testnet address) |
| `VITE_ARC_NETWORK` | `testnet` (default) or `mainnet` |
| `VITE_ARC_CHAIN_ID`, `VITE_ARC_RPC_URL`, `VITE_ARC_EXPLORER_URL` | Chain overrides (sensible per-network defaults) |
| `VITE_ARC_USDC_ADDRESS`, `VITE_ARC_EURC_ADDRESS` | Token overrides (verified mainnet EURC default on mainnet) |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect (optional) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Public Supabase values (anon key is public by design) |
| `VITE_CIRCLE_APP_ID` | Circle app ID (public) |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client (public) |

### Contracts (`contracts/.env`)

`DEPLOYER_PRIVATE_KEY` (never commit), `FEE_WALLET`, `FEE_BPS`, `ARC_USDC_ADDRESS`, `ARC_EURC_ADDRESS`, `ARC_EXPLORER_URL`, `ARC_MAINNET_RPC_URL` (for `--network arc_mainnet`).

> `.env` files are gitignored. Never commit secrets — only `contracts/env_template` is tracked.

---

## Deployment

- **Contract:** `npx hardhat run scripts/deploy.js --network arc_testnet` (or `arc_mainnet` with `ARC_MAINNET_RPC_URL` set). Verify on the explorer, then transfer ownership off the deployer key (multisig recommended).
- **Backend (Render):** set `NODE_ENV=production`, `FRONTEND_URL`, and all secrets above. The service binds `$PORT`.
- **Frontend (Netlify/Vite):** set the `VITE_*` values and point `VITE_BACKEND_URL` at the deployed API.
- **Post-deploy:** run any pending `backend/db` migrations, then smoke-test: login → send → swap → earn deposit/withdraw → CCTP withdraw.

---

## Security model (summary)

- Sessions: 15-min JWT access tokens + rotating HttpOnly refresh cookies, single-use login tickets, jti denylist, reuse detection revokes the session family.
- Money movement: 4-digit scrypt+peppered PIN → single-use 90s approvals bound to exact wallet/destination/amount/token; spending limits; idempotency keys; server-side wallet ownership on every route.
- Swaps: fresh execution-time quotes with a server-side slippage floor.
- Inputs: Zod validation on all mutating routes (unknown fields stripped); SMTP header sanitization; strict CORS + Helmet + per-endpoint rate limits.
- Contract: `Ownable` + `Pausable` + `ReentrancyGuard`, 10% max fee, constructor-allowlisted tokens.

---

## Arc mainnet readiness

| Item | Status |
| ---- | ------ |
| Chain | `5042` (testnet `5042002`); SDKs support `Arc` since `@circle-fin/earn-kit@1.8.0` |
| USDC | `0x3600000000000000000000000000000000000000` (same as testnet) |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` (verified on `explorer.arc.io`: Circle `FiatTokenV2_2`, 6 decimals) |
| Earn | Earn-Kit path confirmed (`EarnChain.Arc`); vault discovery via Circle's Earn API |
| Swap | Tower execution path (sign + submit via dev wallet) |
| Needs | Mainnet Circle keys + funded wallets, contract deploy + verify, prod env on Render/Netlify |

---

## Project structure

```
frontend/          React + Vite app (pages, features, lib)
backend/
  routes/          Express routers (auth, pins, wallets, swap, earn, payments, links, profiles, arcscan)
  services/        Business logic (sessions, pins, otp, mailer, wallets, circle-swaps, swaps, earn, arc, tower, audit)
  middleware/      Zod validation, idempotency
  db/              Numbered Supabase migrations (00–13)
  scripts/         cavo_database.sql (combined schema)
contracts/
  src/Cavo.sol     Payment-link router (fee split, allowlisted tokens)
  scripts/deploy.js  Env-driven deploy (testnet + mainnet)
docs/              Backend security design notes
```

---

## License

MIT
