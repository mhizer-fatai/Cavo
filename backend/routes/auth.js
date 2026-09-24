const express = require("express");
const {
  SESSION_COOKIE_NAME,
  REFRESH_TTL_SECONDS,
  issueSession,
  rotateRefreshToken,
  createLoginTicket,
  consumeLoginTicket,
  verifyGoogleCredential,
  requireCavoSession,
  revokeSessionFamily,
  revokeAllUserSessions,
  revokeJti,
  listUserSessions,
} = require("../services/sessions");
const { requestEmailCode, verifyEmailCode } = require("../services/otp");
const { recordAuditEvent, getClientIp } = require("../services/audit");
const { schemas, validateBody } = require("../middleware/validate");

const router = express.Router();
const isProduction = process.env.NODE_ENV === "production";

function setRefreshCookie(res, refreshToken) {
  res.cookie(SESSION_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/api/auth",
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
}

function clearRefreshCookie(res) {
  res.cookie(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/api/auth",
    maxAge: 0,
  });
}

function readRefreshCookie(req) {
  const header = req.headers?.cookie;
  if (!header) return "";
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE_NAME) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return "";
}

function audit(req, action, outcome, extra = {}) {
  recordAuditEvent({
    userKey: extra.userKey || req.authUserKey || null,
    action,
    outcome,
    ip: getClientIp(req),
    userAgent: req.get("User-Agent"),
    detail: extra.detail ?? null,
  });
}

router.post("/email/token", async (req, res) => {
  return res.status(410).json({
    error: "Circle email login has been retired. Cavo email code login is coming soon.",
  });
});

router.post("/email/request-code", validateBody(schemas.authRequestCode), async (req, res) => {
  try {
    const result = await requestEmailCode(req.body?.email);
    return res.json(result);
  } catch (err) {
    console.error("Email code request error:", err.message || err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to send email code",
    });
  }
});

// OTP possession proof -> full session + single-use login ticket + refresh cookie.
router.post("/email/verify-code", validateBody(schemas.authVerifyCode), async (req, res) => {
  try {
    const { email } = await verifyEmailCode(req.body?.email, req.body?.code);
    const identity = {
      authProvider: "email",
      providerUserId: email,
      email,
      userKey: `email:${email}`,
    };
    const session = await issueSession(identity, {
      userAgent: req.get("User-Agent"),
      ip: getClientIp(req),
    });
    const ticket = createLoginTicket(identity);
    setRefreshCookie(res, session.refreshToken);
    audit(req, "auth.email_login", "ok", { userKey: session.userKey });
    return res.json({
      authProvider: "email",
      providerUserId: email,
      email,
      userKey: session.userKey,
      session: {
        token: session.accessToken,
        expiresAt: session.accessExpiresAt,
        userKey: session.userKey,
      },
      loginTicket: ticket.ticket,
      loginTicketExpiresAt: ticket.expiresAt,
    });
  } catch (err) {
    audit(req, "auth.email_login", "fail", { detail: { reason: err.message } });
    console.error("Email code verify error:", err.message || err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to verify email code",
    });
  }
});

// Session creation is gated: a single-use login ticket (OTP proof) or a
// server-verified Google credential. Client-declared identity alone is rejected.
router.post("/session", validateBody(schemas.authSession), async (req, res) => {
  try {
    const { loginTicket, userToken, displayName } = req.body || {};
    let identity;
    if (loginTicket) {
      identity = await consumeLoginTicket(loginTicket);
    } else if (userToken) {
      identity = await verifyGoogleCredential(userToken);
    } else {
      audit(req, "auth.session_denied", "fail", { detail: { reason: "no proof" } });
      return res.status(401).json({
        error: "A login ticket or verified Google credential is required",
      });
    }
    const session = await issueSession(identity, {
      userAgent: req.get("User-Agent"),
      ip: getClientIp(req),
    });
    setRefreshCookie(res, session.refreshToken);
    audit(req, "auth.session_create", "ok", { userKey: session.userKey });
    return res.json({
      token: session.accessToken,
      expiresAt: session.accessExpiresAt,
      userKey: session.userKey,
      sessionId: session.sessionId,
      displayName: typeof displayName === "string" ? displayName.slice(0, 128) : undefined,
    });
  } catch (err) {
    audit(req, "auth.session_create", "fail", { detail: { reason: err.message } });
    console.error("Cavo session error:", err.message || err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to create Cavo session",
    });
  }
});

// Rotate the refresh cookie -> new access token + rotated refresh cookie.
// Re-presenting an already-rotated token revokes the whole session family.
router.post("/refresh", async (req, res) => {
  try {
    const raw = readRefreshCookie(req);
    if (!raw) return res.status(401).json({ error: "No active session. Please sign in again." });
    const session = await rotateRefreshToken(raw, {
      userAgent: req.get("User-Agent"),
      ip: getClientIp(req),
    });
    setRefreshCookie(res, session.refreshToken);
    return res.json({
      token: session.accessToken,
      expiresAt: session.accessExpiresAt,
      userKey: session.userKey,
      sessionId: session.sessionId,
    });
  } catch (err) {
    clearRefreshCookie(res);
    return res.status(err.status || 401).json({
      error: err.message || "Session refresh failed. Please sign in again.",
    });
  }
});

router.post("/logout", requireCavoSession, async (req, res) => {
  try {
    const session = req.cavoSession;
    await revokeSessionFamily(session.sid);
    await revokeJti(session.jti, "logout", session.exp * 1000);
    clearRefreshCookie(res);
    audit(req, "auth.logout", "ok", { userKey: req.authUserKey });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Logout error:", err.message || err);
    return res.status(500).json({ error: "Logout failed" });
  }
});

router.get("/me", requireCavoSession, async (req, res) => {
  const session = req.cavoSession;
  return res.json({
    userKey: req.authUserKey,
    email: session.email,
    authProvider: session.authProvider,
    sessionId: session.sid,
    expiresAt: new Date(session.exp * 1000).toISOString(),
  });
});

router.get("/sessions", requireCavoSession, async (req, res) => {
  try {
    return res.json({ sessions: await listUserSessions(req.authUserKey) });
  } catch (err) {
    console.error("List sessions error:", err.message || err);
    return res.status(500).json({ error: "Failed to list sessions" });
  }
});

router.delete("/sessions/:sid", requireCavoSession, async (req, res) => {
  try {
    const owned = await listUserSessions(req.authUserKey);
    if (!owned.some((entry) => entry.sessionId === req.params.sid)) {
      return res.status(404).json({ error: "Session not found" });
    }
    await revokeSessionFamily(req.params.sid);
    audit(req, "auth.session_revoke", "ok", {
      userKey: req.authUserKey,
      detail: { sid: req.params.sid },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Revoke session error:", err.message || err);
    return res.status(500).json({ error: "Failed to revoke session" });
  }
});

// Danger zone: revoke every session for this account (account recovery).
router.post("/revoke-all", requireCavoSession, async (req, res) => {
  try {
    await revokeAllUserSessions(req.authUserKey);
    clearRefreshCookie(res);
    audit(req, "auth.revoke_all", "ok", { userKey: req.authUserKey });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Revoke-all error:", err.message || err);
    return res.status(500).json({ error: "Failed to revoke sessions" });
  }
});

module.exports = router;
