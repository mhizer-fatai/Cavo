# Cavopay Backend Security & API Design (Mainnet-Grade)

Status: design spec for mainnet hardening of the existing Express backend.
Catalog basis: AAS `api-security`, `api-security-best-practices`, `api-endpoint-builder`, `api-analyzer`.

---

## 1. Concepts — what each layer actually protects

### Authentication (AuthN) — "who are you"
Proves identity before anything else happens. For Cavopay the proof is **possession of the mailbox** (email OTP). The one rule that matters: **the server must verify possession, never trust a client-declared identity.** Every downstream check (ownership, PIN, balances) is only as strong as this one.

### Authorization (AuthZ) — "what may you do"
Once authenticated, every resource access checks **ownership**: the token's `sub` must own the resource being read or mutated. Identity is derived from the token, never from `req.body` or query. Money-movement endpoints add a **second factor (step-up)**: the Payment PIN.

### Sessions & tokens — "how identity travels"
- **Access token** — short-lived JWT (15 min), sent as `Authorization: Bearer`, verified statelessly. Claims: `sub`, `sid`, `jti`, `iat`, `exp`, `iss`, `aud`. Contains no secrets and never the PIN.
- **Refresh token** — long-lived opaque random (256-bit), `HttpOnly + Secure + SameSite=Strict` cookie, stored **hashed** server-side, **rotated on every use**. Reuse of an already-rotated token = theft signal → revoke the whole session family.
- **Why two tokens**: a stolen access token dies in ≤ 15 min. A stolen refresh token can be detected and revoked. A single long-lived JWT is unrecoverable until it expires.
- **HS256 → RS256**: with HS256, every verifier must hold the signing secret — one leak forges every session for every user. Mainnet signs with a private key (RS256/EdDSA) and verifies with the public key; keys rotate via the `kid` header.
- **Revocation**: denylist by `jti` (row with TTL = token remaining life). Logout revokes the `sid` family.

### Hardening — "how attackers get stopped"
| Control | Purpose |
|---|---|
| TLS + HSTS | No plaintext, no downgrade |
| helmet | CSP, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy |
| CORS allowlist | Exact origins only; `credentials: true` only on cookie endpoints |
| Schema validation (zod) | Reject unknown/oversized fields on every route; canonicalize addresses (EVM lowercase, Solana base58 byte-preserved) |
| Rate limiting | Global per-IP + strict per-identity buckets on auth / PIN / payments |
| PIN lockout | `failed_attempts` + `locked_until` (already implemented) |
| Idempotency keys | `Idempotency-Key` on money-movement POSTs; retries return the original result — prevents double-send |
| Audit log | Append-only: who, what, when, ip, outcome — every auth + money event |
| Secret hygiene | Dedicated `CAVOPAY_SESSION_SECRET` (32+ bytes), **no fallback to Circle secrets**, rotate quarterly |
| DB least privilege | Supabase RLS; backend uses service role only server-side |
| Replay protection | Single-use OTP codes; one-time tracking IDs |

---

## 2. Current-state audit (what exists today)

### Already solid
- HS256 session JWT with `timingSafeEqual` verification (sessions.js)
- PIN: scrypt (64-byte, random salt) + pepper + constant-time compare + lockout (pins.js)
- Email OTP: HMAC-hashed codes + attempt limits (otp.js)
- Rate limiters on `/api/links`, `/api/swap`, `/api/earn` (index.js:78-84)
- Ownership middleware `requireMatchingUserKey` on most routes

### Critical — blocks mainnet
1. **`POST /api/auth/session` mints a valid session for any client-declared email.** It validates format only — no OTP, no signature, no possession proof (auth.js:50-52 → cavopaySessionService.js:26-58). Anyone who knows a victim's email can forge a token and pass every `requireMatchingUserKey` check. This is the hole the entire chain sits behind.
2. **Session secret falls back to `CIRCLE_ENTITY_SECRET` / `CIRCLE_API_KEY`** (cavopaySessionService.js:10). One leaked Circle secret = forged sessions for all users.
3. **No refresh token** — 1-hour TTL, hard re-login, no rotation.
4. **No revocation** — no `jti`/`sid` denylist; logout does not invalidate; a stolen token is valid until exp.
5. **No `iss` / `aud` claims** — tokens are valid in any context.
6. **No rate limits on `/api/auth`, `/api/payments`, `/api/cavopay-pin`, `/api/profiles`, `/api/wallets`** — money-movement and PIN endpoints can be hammered.
7. **`POST /api/payments` has no auth middleware at all** (payments.js:19).
8. **No helmet, no idempotency keys** on money movement.

---

## 3. Target endpoint spec

Legend: **ACCESS** = valid access JWT · **PIN** = Payment PIN step-up · **OWN** = resource owner only · **PUB** = public.

### Auth — session establishment
| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| POST | `/api/auth/otp/request` | PUB | Send login code | 3 / 10 min / email + IP bucket; single-use, 5-min TTL |
| POST | `/api/auth/otp/verify` | PUB | **Establish session** | Verifies possession → creates user if new → sets refresh cookie → `{ accessToken, user }` |
| POST | `/api/auth/refresh` | refresh cookie | Rotate session | New access + rotated refresh; reuse → revoke family |
| POST | `/api/auth/logout` | ACCESS | End session | Revoke `sid` family, clear cookie |
| GET | `/api/auth/me` | ACCESS | Session claims + profile | |
| GET | `/api/auth/sessions` | ACCESS | List active sessions | |
| DELETE | `/api/auth/sessions/:sid` | ACCESS+OWN | Revoke one session | |

### Profiles
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/profiles` | ACCESS | Create own profile |
| PATCH | `/api/profiles/me` | ACCESS | Update own profile |
| PATCH | `/api/profiles/:username/avatar` | ACCESS+OWN | Own avatar only |
| GET | `/api/profiles/:username` | PUB | Resolve payee |
| GET | `/api/profiles/wallet/:address` | PUB | Resolve by wallet |

### Wallets (Circle / Arc)
| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| GET | `/api/wallets/me` | ACCESS | Balances + wallet list | identity from token |
| POST | `/api/wallets/create` | ACCESS | Create Circle wallet | idempotent per user |
| POST | `/api/wallets/send` | ACCESS+PIN | Cavopay-to-Cavopay send (Arc only) | `Idempotency-Key` required |
| POST | `/api/wallets/bridge` | ACCESS+PIN | CCTP bridge to EOA on any supported chain | address validated per chain; `Idempotency-Key` required |
| GET | `/api/wallets/transactions/:trackingId` | ACCESS+OWN | Tx status | |
| GET | `/api/wallets/destination-chains` | PUB | Supported CCTP chains | |

### Payments (ledger)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/payments` | ACCESS | Log payment (identity from token) — closes audit gap #7 |
| GET | `/api/payments/payer/:address` | ACCESS+OWN | Own sent history |
| GET | `/api/payments/creator/:address` | ACCESS+OWN | Own received history |
| GET | `/api/payments/link/:linkId` | PUB (link token) or ACCESS | Claim/lookup via payment link |

### Payment PIN (step-up factor)
| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| GET | `/api/cavopay-pin/status` | ACCESS | Has PIN? | |
| POST | `/api/cavopay-pin/setup` | ACCESS | Create PIN | scrypt + pepper (existing) |
| POST | `/api/cavopay-pin/change` | ACCESS+PIN | Change PIN | requires current PIN |
| POST | `/api/cavopay-pin/approve` | ACCESS | Approve a transaction binding | strict rate limit; binds amount/chain/recipient |
| POST | `/api/cavopay-pin/recovery-question` | ACCESS | Set recovery answers | |
| POST | `/api/cavopay-pin/recover` | PUB (strict) | Recover via answers | lockout + IP bucket |

### Earn (ArcLend)
| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| GET | `/api/earn/vaults` | PUB | Vault list + APY | |
| GET | `/api/earn/positions` | ACCESS | User positions | |
| GET | `/api/earn/history` | ACCESS | Earn events | |
| POST | `/api/earn/deposit` | ACCESS+PIN | Deposit | `Idempotency-Key` required |
| POST | `/api/earn/withdraw` | ACCESS+PIN | Withdraw (+ optional CCTP bridge) | destination chain/address validated |

### Swap
| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| POST | `/api/swap/quote` | ACCESS | Quote | |
| POST | `/api/swap/execute` | ACCESS+PIN | Execute | `Idempotency-Key` required |
| GET | `/api/swap/history` | ACCESS | History | |

### Links
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/links` | ACCESS | Create payment link |
| GET | `/api/links/:id` | PUB (link token) | Open link |
| GET | `/api/links/creator/:address` | ACCESS+OWN | Own links |

### Ops
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | PUB | Liveness |
| GET | `/api/health/ready` | PUB | Readiness: DB + Circle API |

### Middleware chain (order matters)
```
request-id → helmet → cors(allowlist) → rate-limit
  → authenticate (verify JWT sig + exp + jti-not-revoked)
  → authorize (ownership from token sub / PIN step-up)
  → validate (zod schema, address canonicalization)
  → handler → audit-log
```

---

## 4. Token design — concrete

### Access JWT (RS256, `kid`-keyed)
```json
{
  "iss": "cavopay-api",
  "aud": "cavopay-web",
  "sub": "email:user@example.com",
  "sid": "<session-id>",
  "jti": "<token-id>",
  "iat": 1758500000,
  "exp": 1758500900
}
```
TTL 900 s (15 min). Delivered in the JSON body at login/refresh; held in memory by the client (never `localStorage` for long-lived values).

### Refresh token
- 256-bit random value; only its SHA-256 hash is stored server-side.
- Cookie: `cavopay_rt` — `HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=2592000` (30 d); `Secure` in production.
- Rotated on every `/api/auth/refresh`; rotation chain tracked per session (`sid`).
- Re-presenting an already-rotated token = theft signal → whole `sid` family revoked.

### Schema additions (Supabase)
```sql
create table if not exists cavopay_sessions (
  id uuid primary key default gen_random_uuid(),
  user_key text not null,
  refresh_hash text not null,
  user_agent text,
  ip inet,
  created_at timestamptz default now(),
  last_refresh_at timestamptz default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists cavopay_sessions_user_idx on cavopay_sessions (user_key);

create table if not exists cavopay_revoked_jti (
  jti text primary key,
  expires_at timestamptz not null
);
-- rows purge naturally: authenticate() ignores jti rows whose expires_at has passed
```

### Idempotency table
```sql
create table if not exists api_idempotency (
  key text primary key,
  user_key text not null,
  endpoint text not null,
  response jsonb not null,
  status_code int not null,
  created_at timestamptz default now()
);
```

---

## 5. Implementation order (each step independently shippable)

1. **Close the `/session` hole** — make `POST /api/auth/otp/verify` the only session-establishing endpoint; delete or gate `POST /api/auth/session` behind OTP verification. *Highest severity, smallest diff.*
2. **Dedicated session secret** — require `CAVOPAY_SESSION_SECRET` (fail closed), remove Circle fallbacks. Generate RS256 keypair + `kid` when moving to asymmetric signing.
3. **Refresh rotation + revocation** — add `cavopay_sessions` + `cavopay_revoked_jti`; implement `/api/auth/refresh`, `/api/auth/logout`, session list/revoke.
4. **Derive identity from token** — `requireMatchingUserKey` stops reading `req.body.userKey`; handlers use `req.cavopaySession.sub`.
5. **Missing rate limits + helmet** — strict buckets on auth / PIN / payments / profiles / wallets; helmet defaults + CSP.
6. **Idempotency middleware** — `api_idempotency` table + wrapper on money-movement POSTs.
7. **Schema validation** — zod schemas per route; reject unknown fields; canonicalize addresses.
8. **Audit log** — append-only writes for auth + money events (who, what, when, ip, outcome).
