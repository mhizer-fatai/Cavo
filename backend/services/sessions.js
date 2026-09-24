const crypto = require("crypto");
const { memStore } = require("../supabase");

// Mainnet session security.
// - Access token: short-lived HS256 JWT (15 min), verified statelessly + jti denylist.
// - Refresh token: opaque 256-bit value, SHA-256 hashed at rest, rotated on every
//   use. Reuse of a rotated token revokes the whole session family (theft signal).
// - Login ticket: single-use 5-minute JWT minted only after OTP possession proof.
//   POST /api/auth/session requires one — never trust client-declared identity.
// - Google credentials are verified server-side against Google tokeninfo.

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_TICKET_TTL_SECONDS = 5 * 60;
const ISSUER = "cavopay-api";
const AUDIENCE = "cavopay-web";
const SESSION_COOKIE_NAME = "cavopay_rt";

let supabase = null;
function setSupabase(client) {
  supabase = client;
}

let tablesMissingWarned = false;

// Runs dbFn against Supabase, falling back to memFn when the security tables
// have not been migrated yet (backend/db/11_security.sql). The
// fallback is loud and in-memory only — sessions are lost on restart.
async function withDbFallback(memFn, dbFn) {
  if (!supabase) return memFn();
  try {
    return await dbFn(supabase);
  } catch (err) {
    if (err && err.code === "PGRST205") {
      supabase = null;
      if (!tablesMissingWarned) {
        tablesMissingWarned = true;
        console.warn(
          "Session security tables missing — run backend/db/11_security.sql. " +
            "Using in-memory sessions (lost on restart)."
        );
      }
      return memFn();
    }
    throw err;
  }
}

// Boot-time probe so a missing migration is visible immediately in logs.
async function probeSessionTables() {
  if (!supabase) return "memory";
  try {
    const { error } = await supabase.from("cavopay_sessions").select("id").limit(1);
    if (error) throw error;
    return "supabase";
  } catch (err) {
    if (err && err.code === "PGRST205") {
      supabase = null;
      console.warn(
        "Session security tables missing — run backend/db/11_security.sql. " +
          "Using in-memory sessions (lost on restart)."
      );
      return "memory";
    }
    console.warn("Session table probe failed:", err.message || err);
    return "supabase";
  }
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

// Fail closed: a dedicated session secret is mandatory. Falling back to a
// Circle secret would let one leaked Circle credential forge every session.
function getSessionSecret() {
  const secret = process.env.CAVOPAY_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("CAVOPAY_SESSION_SECRET is not configured (min 32 chars). Refusing to sign sessions.");
  }
  return secret;
}

function getGoogleClientId() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");
  return clientId;
}

function signPayload(payload) {
  return crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function mintJwt(claims) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  return `${header}.${payload}.${signPayload(`${header}.${payload}`)}`;
}

function decodeAndVerifySignature(token) {
  const [header, payload, signature] = String(token || "").split(".");
  if (!header || !payload || !signature) {
    throw Object.assign(new Error("Missing or invalid token"), { status: 401 });
  }
  const expected = signPayload(`${header}.${payload}`);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw Object.assign(new Error("Invalid token signature"), { status: 401 });
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid token payload"), { status: 401 });
  }
}

function normalizeUserKey(userKey) {
  return String(userKey || "").trim().toLowerCase();
}

function validateSessionIdentity({ authProvider, providerUserId, email, userKey }) {
  const normalizedProvider = String(authProvider || "").trim().toLowerCase();
  const normalizedUserKey = normalizeUserKey(userKey);
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedProviderUserId = String(providerUserId || "").trim().toLowerCase();

  if (!["google", "email"].includes(normalizedProvider)) {
    throw Object.assign(new Error("Unsupported auth provider"), { status: 400 });
  }
  if (!normalizedUserKey || !normalizedProviderUserId) {
    throw Object.assign(new Error("Missing login identity"), { status: 400 });
  }
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw Object.assign(new Error("Valid login email is required"), { status: 400 });
  }
  // Cavopay convention: userKey is `email:<address>` for both email and
  // Google logins (see frontend buildGoogleUserKey). The provider distinction
  // lives in authProvider, not in the key.
  if (!normalizedUserKey.startsWith(`email:${normalizedEmail}`)) {
    throw Object.assign(new Error("Login identity does not match Cavopay account"), { status: 403 });
  }

  return {
    authProvider: normalizedProvider,
    providerUserId: normalizedProviderUserId,
    email: normalizedEmail,
    userKey: normalizedUserKey,
  };
}

// ---- Revocation (jti denylist) ----

async function isJtiRevoked(jti) {
  if (!jti) return false;
  return withDbFallback(
    () => {
      const expiresAtMs = memStore.cavopayRevokedJti.get(jti);
      if (!expiresAtMs) return false;
      if (expiresAtMs < Date.now()) {
        memStore.cavopayRevokedJti.delete(jti);
        return false;
      }
      return true;
    },
    async (db) => {
      const { data, error } = await db
        .from("cavopay_revoked_jti")
        .select("jti, expires_at")
        .eq("jti", jti)
        .maybeSingle();
      if (error) throw error;
      if (!data) return false;
      if (new Date(data.expires_at).getTime() < Date.now()) return false;
      return true;
    }
  );
}

async function revokeJti(jti, reason, expiresAtMs) {
  if (!jti) return;
  return withDbFallback(
    () => {
      memStore.cavopayRevokedJti.set(jti, expiresAtMs);
    },
    async (db) => {
      const { error } = await db.from("cavopay_revoked_jti").upsert(
        {
          jti,
          reason: reason || "revoked",
          expires_at: new Date(expiresAtMs).toISOString(),
        },
        { onConflict: "jti" }
      );
      if (error) throw error;
    }
  );
}

// ---- Access tokens ----

function createAccessToken(identity, sessionId) {
  const verified = validateSessionIdentity(identity);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    ...verified,
    iss: ISSUER,
    aud: AUDIENCE,
    sub: verified.userKey,
    sid: sessionId,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + ACCESS_TTL_SECONDS,
  };
  return {
    token: mintJwt(claims),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    sessionId,
    jti: claims.jti,
    userKey: verified.userKey,
  };
}

async function verifyCavopaySession(token) {
  const claims = decodeAndVerifySignature(token);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) {
    throw Object.assign(new Error("Token was not issued for Cavopay"), { status: 401 });
  }
  if (claims.purpose && claims.purpose !== "access") {
    throw Object.assign(new Error("Wrong token purpose"), { status: 401 });
  }
  if (!claims.exp || claims.exp < now) {
    throw Object.assign(new Error("Cavopay session expired. Please sign in again."), { status: 401 });
  }
  if (!claims.sub || !claims.sid || !claims.jti) {
    throw Object.assign(new Error("Cavopay session is missing identity"), { status: 401 });
  }
  if (await isJtiRevoked(claims.jti)) {
    throw Object.assign(new Error("Cavopay session was revoked. Please sign in again."), { status: 401 });
  }
  return claims;
}

// Legacy 1-hour tokens (pre-mainnet) have no iss/aud/sid/jti and are rejected.
function requireCavopaySession(req, res, next) {
  const auth = req.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  verifyCavopaySession(token)
    .then((claims) => {
      req.cavopaySession = claims;
      req.authUserKey = normalizeUserKey(claims.sub || claims.userKey);
      next();
    })
    .catch((err) => res.status(err.status || 401).json({ error: err.message || "Unauthorized" }));
}

// Authorization: identity is derived purely from the verified token — never
// from client-supplied fields. A request that *claims* a different identity
// is rejected outright (confused-deputy defense). Handlers must use
// req.authUserKey and never read userKey from body/query for decisions.
function requireMatchingUserKey(req, res, next) {
  const sessionUserKey = normalizeUserKey(req.cavopaySession?.sub || req.cavopaySession?.userKey);
  if (!sessionUserKey) {
    return res.status(401).json({ error: "Cavopay session is missing identity" });
  }
  req.authUserKey = sessionUserKey;
  const claimedUserKey = normalizeUserKey(req.body?.userKey || req.query?.userKey);
  if (claimedUserKey && claimedUserKey !== sessionUserKey) {
    return res.status(403).json({ error: "Cavopay session does not match this account" });
  }
  next();
}

// Financial-history ownership: does this wallet belong to this account?
// Fail closed without a persistence layer to verify against.
async function ownsWalletAddress(userKey, address) {
  const raw = String(address || "").trim();
  const normalized = /^0x[a-fA-F0-9]{40}$/.test(raw) ? raw.toLowerCase() : raw;
  if (!normalized || !supabase) return false;
  const { data, error } = await supabase
    .from("user_wallets")
    .select("wallet_address")
    .eq("user_address", normalizeUserKey(userKey))
    .eq("wallet_address", normalized)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// ---- Login tickets (single-use, minted only after possession proof) ----

function createLoginTicket(identity) {
  const verified = validateSessionIdentity(identity);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    ...verified,
    iss: ISSUER,
    aud: AUDIENCE,
    sub: verified.userKey,
    purpose: "login",
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + LOGIN_TICKET_TTL_SECONDS,
  };
  return {
    ticket: mintJwt(claims),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

async function consumeLoginTicket(ticket) {
  const claims = decodeAndVerifySignature(ticket);
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.purpose !== "login") {
    throw Object.assign(new Error("Invalid login ticket"), { status: 401 });
  }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("Login ticket expired. Please sign in again."), { status: 401 });
  }
  if (await isJtiRevoked(claims.jti)) {
    throw Object.assign(new Error("Login ticket already used. Please sign in again."), { status: 401 });
  }
  // Single-use: burn the ticket before issuing the session.
  await revokeJti(claims.jti, "login-ticket-consumed", claims.exp * 1000);
  return validateSessionIdentity(claims);
}

// ---- Refresh-token rotation ----

async function insertSessionRow(row) {
  return withDbFallback(
    () => {
      memStore.cavopaySessions.set(row.refresh_hash, row);
      return row;
    },
    async (db) => {
      const { data, error } = await db.from("cavopay_sessions").insert(row).select().single();
      if (error) throw error;
      return data;
    }
  );
}

async function findSessionRow(refreshHash) {
  return withDbFallback(
    () => memStore.cavopaySessions.get(refreshHash) || null,
    async (db) => {
      const { data, error } = await db
        .from("cavopay_sessions")
        .select("*")
        .eq("refresh_hash", refreshHash)
        .maybeSingle();
      if (error) throw error;
      return data;
    }
  );
}

async function markSessionRowRevoked(refreshHash) {
  const now = new Date().toISOString();
  return withDbFallback(
    () => {
      const row = memStore.cavopaySessions.get(refreshHash);
      if (row) memStore.cavopaySessions.set(refreshHash, { ...row, revoked_at: now });
    },
    async (db) => {
      const { error } = await db.from("cavopay_sessions").update({ revoked_at: now }).eq("refresh_hash", refreshHash);
      if (error) throw error;
    }
  );
}

async function revokeSessionFamily(sessionId) {
  const now = new Date().toISOString();
  return withDbFallback(
    () => {
      for (const [hash, row] of memStore.cavopaySessions.entries()) {
        if (row.session_id === sessionId && !row.revoked_at) {
          memStore.cavopaySessions.set(hash, { ...row, revoked_at: now });
        }
      }
    },
    async (db) => {
      const { error } = await db
        .from("cavopay_sessions")
        .update({ revoked_at: now })
        .eq("session_id", sessionId)
        .is("revoked_at", null);
      if (error) throw error;
    }
  );
}

// Issues a full session: access token + refresh token row.
async function issueSession(identity, { userAgent, ip } = {}) {
  const verified = validateSessionIdentity(identity);
  const sessionId = crypto.randomUUID();
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await insertSessionRow({
    id: crypto.randomUUID(),
    session_id: sessionId,
    user_key: verified.userKey,
    auth_provider: verified.authProvider,
    provider_user_id: verified.providerUserId,
    email: verified.email,
    refresh_hash: sha256Hex(refreshToken),
    user_agent: userAgent ? String(userAgent).slice(0, 255) : null,
    ip: ip ? String(ip).slice(0, 64) : null,
    created_at: now.toISOString(),
    last_refresh_at: now.toISOString(),
    expires_at: new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000).toISOString(),
    revoked_at: null,
  });
  const access = createAccessToken(verified, sessionId);
  return {
    ...verified,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken,
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000).toISOString(),
    sessionId,
  };
}

// Rotates a refresh token. Re-presenting an already-rotated token means theft:
// the whole session family is revoked.
async function rotateRefreshToken(rawRefreshToken, { userAgent, ip } = {}) {
  const hash = sha256Hex(String(rawRefreshToken || ""));
  const row = await findSessionRow(hash);
  if (!row) {
    throw Object.assign(new Error("Refresh token not recognized. Please sign in again."), { status: 401 });
  }
  if (row.revoked_at) {
    await revokeSessionFamily(row.session_id);
    throw Object.assign(new Error("Session reuse detected. All sessions revoked — please sign in again."), {
      status: 401,
    });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await markSessionRowRevoked(hash);
    throw Object.assign(new Error("Session expired. Please sign in again."), { status: 401 });
  }
  await markSessionRowRevoked(hash);
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await insertSessionRow({
    id: crypto.randomUUID(),
    session_id: row.session_id,
    user_key: row.user_key,
    auth_provider: row.auth_provider || "email",
    provider_user_id: row.provider_user_id || null,
    email: row.email || null,
    refresh_hash: sha256Hex(refreshToken),
    user_agent: userAgent ? String(userAgent).slice(0, 255) : row.user_agent,
    ip: ip ? String(ip).slice(0, 64) : row.ip,
    created_at: now.toISOString(),
    last_refresh_at: now.toISOString(),
    expires_at: row.expires_at,
    revoked_at: null,
  });
  // Re-derive identity from the stored session row.
  const provider = row.auth_provider === "google" ? "google" : "email";
  const storedEmail = String(row.email || "");
  const identity = {
    authProvider: provider,
    providerUserId: String(row.provider_user_id || storedEmail || row.user_key),
    email: storedEmail || row.user_key,
    userKey: row.user_key,
  };
  const access = createAccessToken(identity, row.session_id);
  return {
    userKey: row.user_key,
    email: identity.email,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken,
    refreshExpiresAt: row.expires_at,
    sessionId: row.session_id,
  };
}

async function listUserSessions(userKey) {
  const normalized = normalizeUserKey(userKey);
  const now = new Date().toISOString();
  const shape = (row) => ({
    sessionId: row.session_id,
    createdAt: row.created_at,
    lastRefreshAt: row.last_refresh_at,
    expiresAt: row.expires_at,
    userAgent: row.user_agent,
    ip: row.ip,
  });
  return withDbFallback(
    () =>
      [...memStore.cavopaySessions.values()]
        .filter((row) => row.user_key === normalized && !row.revoked_at && row.expires_at > now)
        .map(shape),
    async (db) => {
      const { data, error } = await db
        .from("cavopay_sessions")
        .select("session_id, created_at, last_refresh_at, expires_at, user_agent, ip")
        .eq("user_key", normalized)
        .is("revoked_at", null)
        .gt("expires_at", now);
      if (error) throw error;
      return (data || []).map(shape);
    }
  );
}

async function revokeAllUserSessions(userKey) {
  const normalized = normalizeUserKey(userKey);
  const now = new Date().toISOString();
  return withDbFallback(
    () => {
      for (const [hash, row] of memStore.cavopaySessions.entries()) {
        if (row.user_key === normalized && !row.revoked_at) {
          memStore.cavopaySessions.set(hash, { ...row, revoked_at: now });
        }
      }
    },
    async (db) => {
      const { error } = await db
        .from("cavopay_sessions")
        .update({ revoked_at: now })
        .eq("user_key", normalized)
        .is("revoked_at", null);
      if (error) throw error;
    }
  );
}

// ---- Google credential verification (server-side, via Google tokeninfo) ----

function looksLikeJwt(value) {
  return typeof value === "string" && value.split(".").length === 3;
}

async function verifyGoogleCredential(userToken) {
  const clientId = getGoogleClientId();
  const credential = String(userToken || "").trim();
  if (!credential) throw Object.assign(new Error("Google credential is required"), { status: 400 });
  const params = new URLSearchParams(
    looksLikeJwt(credential) ? { id_token: credential } : { access_token: credential }
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?${params.toString()}`, {
      signal: controller.signal,
    });
  } catch (error) {
    throw Object.assign(
      new Error(error?.name === "AbortError" ? "Google verification timed out" : "Google verification unreachable"),
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
  const info = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error("Google credential is invalid or expired"), { status: 401 });
  }
  if (info.aud !== clientId) {
    throw Object.assign(new Error("Google credential was issued for a different app"), { status: 401 });
  }
  const email = String(info.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error("Google credential has no email"), { status: 401 });
  }
  // tokeninfo only returns 200 for live, correctly-signed tokens, but enforce expiry anyway.
  if (info.exp && Number(info.exp) * 1000 < Date.now()) {
    throw Object.assign(new Error("Google credential is expired"), { status: 401 });
  }
  if (info.email_verified !== undefined && String(info.email_verified).toLowerCase() !== "true") {
    throw Object.assign(new Error("Google email is not verified"), { status: 401 });
  }
  const sub = String(info.sub || email);
  return {
    authProvider: "google",
    providerUserId: sub,
    email,
    userKey: `email:${email}`,
  };
}

module.exports = {
  setSupabase,
  probeSessionTables,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  normalizeUserKey,
  createAccessToken,
  verifyCavopaySession,
  requireCavopaySession,
  requireMatchingUserKey,
  ownsWalletAddress,
  createLoginTicket,
  consumeLoginTicket,
  issueSession,
  rotateRefreshToken,
  revokeSessionFamily,
  revokeAllUserSessions,
  listUserSessions,
  revokeJti,
  verifyGoogleCredential,
};
