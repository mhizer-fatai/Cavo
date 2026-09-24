// Idempotency for money-movement POSTs. A client sends Idempotency-Key with a
// mutating request; replays with the same key return the stored response
// instead of executing the operation again (double-send protection).
const { memStore } = require("../supabase");
const { recordAuditEvent, getClientIp } = require("../services/audit");

let supabase = null;
let useMemory = false;
function setSupabase(client) {
  supabase = client;
}

const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

function missingTable(err) {
  if (err && err.code === "PGRST205" && !useMemory) {
    useMemory = true; // table not migrated yet — loud once, then memory
    console.warn("api_idempotency table missing — run backend/db/11_security.sql. Idempotency in memory.");
    return true;
  }
  return false;
}

const AUDIT_ACTIONS = [
  ["/wallets/send", "money.send"],
  ["/wallets/bridge", "money.bridge"],
  ["/earn/deposit", "money.earn_deposit"],
  ["/earn/withdraw", "money.earn_withdraw"],
  ["/swap/execute", "money.swap"],
];

function auditActionForEndpoint(endpoint) {
  for (const [suffix, action] of AUDIT_ACTIONS) {
    if (endpoint.endsWith(suffix)) return action;
  }
  return "money.operation";
}

// Safe audit detail: amounts and destinations only — never secrets or PINs.
function auditDetail(req) {
  const body = req.body || {};
  const detail = {};
  for (const field of ["amount", "token", "destinationAddress", "destinationChain", "tokenIn", "tokenOut"]) {
    if (body[field] !== undefined) detail[field] = String(body[field]).slice(0, 128);
  }
  return detail;
}

function writeAudit(req, action, outcome) {
  recordAuditEvent({
    userKey: req.authUserKey || null,
    action,
    outcome,
    ip: getClientIp(req),
    userAgent: req.get("User-Agent"),
    detail: auditDetail(req),
  });
}

async function findRecord(userKey, key) {
  const composite = `${userKey}:${key}`;
  if (!supabase || useMemory) return memStore.apiIdempotency.get(composite) || null;
  try {
    const { data, error } = await supabase
      .from("api_idempotency")
      .select("endpoint, response, status_code")
      .eq("key", composite)
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch (err) {
    if (missingTable(err)) return memStore.apiIdempotency.get(composite) || null;
    throw err;
  }
}

async function storeRecord(userKey, key, endpoint, response, statusCode) {
  const composite = `${userKey}:${key}`;
  const record = { endpoint, response, statusCode };
  if (!supabase || useMemory) {
    memStore.apiIdempotency.set(composite, record);
    if (memStore.apiIdempotency.size > 1000) {
      const oldest = memStore.apiIdempotency.keys().next().value;
      memStore.apiIdempotency.delete(oldest);
    }
    return;
  }
  try {
    const { error } = await supabase.from("api_idempotency").upsert(
      {
        key: composite,
        user_key: userKey,
        endpoint,
        response,
        status_code: statusCode,
      },
      { onConflict: "key" }
    );
    if (error) throw error;
  } catch (err) {
    if (missingTable(err)) {
      memStore.apiIdempotency.set(composite, record);
      return;
    }
    throw err;
  }
}

// Must run AFTER requireCavoSession (uses req.authUserKey).
function idempotencyGuard(req, res, next) {
  const key = req.get("Idempotency-Key");
  if (!key) return next(); // backward compatible; frontend always sends one
  if (!KEY_RE.test(key)) {
    return res.status(400).json({ error: "Invalid Idempotency-Key format" });
  }
  const userKey = req.authUserKey;
  const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
  findRecord(userKey, key)
    .then((stored) => {
      if (stored) {
        if (stored.endpoint !== endpoint) {
          return res.status(422).json({ error: "Idempotency-Key was used for a different operation" });
        }
        writeAudit(req, auditActionForEndpoint(endpoint), "replay");
        return res.status(stored.status_code || 200).json(stored.response);
      }
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          storeRecord(userKey, key, endpoint, body, res.statusCode).catch((err) =>
            console.error("Idempotency store failed:", err.message || err)
          );
          writeAudit(req, auditActionForEndpoint(endpoint), "ok");
        } else {
          writeAudit(req, auditActionForEndpoint(endpoint), "fail");
        }
        return originalJson(body);
      };
      next();
    })
    .catch((err) => {
      console.error("Idempotency lookup failed:", err.message || err);
      next();
    });
}

module.exports = { setSupabase, idempotencyGuard };
