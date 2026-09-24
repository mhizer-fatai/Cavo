const { memStore } = require("../supabase");

// Append-only security audit log. Writes never throw — a logging failure
// must not break the request it is observing.
let supabase = null;
let useMemory = false;
function setSupabase(client) {
  supabase = client;
}

function getClientIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim().slice(0, 64);
  }
  return String(req?.socket?.remoteAddress || "").slice(0, 64) || null;
}

async function recordAuditEvent({ userKey, action, outcome = "ok", ip, userAgent, detail }) {
  const event = {
    id: require("crypto").randomUUID(),
    user_key: userKey ? String(userKey).slice(0, 255) : null,
    action: String(action || "unknown").slice(0, 128),
    outcome: String(outcome || "ok").slice(0, 32),
    ip: ip ? String(ip).slice(0, 64) : null,
    user_agent: userAgent ? String(userAgent).slice(0, 255) : null,
    detail: detail === undefined ? null : detail,
    created_at: new Date().toISOString(),
  };
  try {
    if (!supabase || useMemory) {
      memStore.cavopayAuditLog.push(event);
      if (memStore.cavopayAuditLog.length > 500) {
        memStore.cavopayAuditLog.splice(0, memStore.cavopayAuditLog.length - 500);
      }
      return;
    }
    const { error } = await supabase.from("cavopay_audit_log").insert(event);
    if (error) throw error;
  } catch (err) {
    if (err && err.code === "PGRST205" && !useMemory) {
      useMemory = true; // table not migrated yet — loud once, then memory
      console.warn("cavopay_audit_log table missing — run backend/db/11_security.sql. Auditing to memory.");
      memStore.cavopayAuditLog.push(event);
      return;
    }
    console.error("Audit log write failed:", err.message || err);
  }
}

module.exports = { setSupabase, getClientIp, recordAuditEvent };
