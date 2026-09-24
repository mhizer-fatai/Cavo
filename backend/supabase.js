const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const usingServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

// Fallback in-memory store (data is lost on server restart — dev only)
const memStore = {
  links: new Map(),
  payments: [],
  profiles: new Map(),
  emailLoginCodes: [],
  // Mainnet session security fallbacks (Supabase tables in db/11_security.sql)
  cavoSessions: new Map(), // refreshHash -> session row
  cavoRevokedJti: new Map(), // jti -> expiresAtMs
  apiIdempotency: new Map(), // `${userKey}:${key}` -> { endpoint, response, statusCode }
  cavoAuditLog: [],
};

let supabase = null;

if (!supabaseUrl || !supabaseKey) {
  console.warn("Supabase credentials not set; using in-memory store. Data will not persist across restarts.");
} else {
  try {
    if (!usingServiceRole) {
      console.warn("Supabase service role key is not set. Backend is using anon key; sensitive RLS-locked writes may fail.");
    }
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    console.log("Supabase client initialized.");
  } catch (e) {
    console.error("Supabase client failed to initialize:", e.message);
    console.warn("Falling back to in-memory store.");
  }
}

module.exports = { supabase, memStore, usingServiceRole };
