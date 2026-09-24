const crypto = require("crypto");
const { supabase, memStore } = require("../supabase");
const { sendEmail } = require("./mailer");

const OTP_EXPIRES_MINUTES = Number(process.env.OTP_EXPIRES_MINUTES || 10);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_RESEND_COOLDOWN_SECONDS = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function assertValidEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error("Valid email is required"), { status: 400 });
  }
}

function getEmailCodeSecret() {
  const secret = process.env.EMAIL_CODE_SECRET || process.env.OTP_PEPPER;
  if (!secret) throw Object.assign(new Error("EMAIL_CODE_SECRET is not configured"), { status: 500 });
  return secret;
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(email, code) {
  return crypto
    .createHmac("sha256", getEmailCodeSecret())
    .update(`${email}:${code}`)
    .digest("hex");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildEmailHtml(code) {
  const spacedCode = code.split("").join(" ");
  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#05080c;font-family:Inter,Arial,sans-serif;color:#f8fafc;">
    <div style="max-width:600px;margin:0 auto;padding:34px 18px;">
      <div style="background:#0b1018;border:1px solid #1e2a38;border-radius:30px;overflow:hidden;">
        <div style="height:5px;background:linear-gradient(90deg,#18d8ef,#22d3ee,#14b8a6);"></div>
        <div style="padding:34px 30px 32px;">
          <div style="margin-bottom:34px;">
            <div style="color:#ffffff;font-size:24px;font-weight:900;letter-spacing:-.03em;">Cavo</div>
            <div style="color:#7f93a8;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Secure login</div>
          </div>

          <div style="color:#d8e4ee;font-size:17px;line-height:1.5;font-weight:700;margin-bottom:22px;">Your Cavo login code is</div>

          <div style="background:#111827;border:1px solid #253243;border-radius:24px;padding:30px 18px;text-align:center;margin-bottom:26px;">
            <span style="font-size:48px;line-height:1;font-weight:900;letter-spacing:.24em;color:#ffffff;">${escapeHtml(spacedCode)}</span>
          </div>

          <div style="color:#95a3b7;font-size:14px;line-height:1.7;">
            This code expires in ${OTP_EXPIRES_MINUTES} minutes. Do not share it with anyone.
          </div>
          <div style="margin-top:24px;padding-top:20px;border-top:1px solid #1e2a38;color:#66768a;font-size:12px;line-height:1.6;">
            If you did not request this login code, you can safely ignore this email.
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function buildEmailText(code) {
  return [
    "Cavo",
    "",
    `Your Cavo login code is: ${code}`,
    "",
    `This code expires in ${OTP_EXPIRES_MINUTES} minutes. Do not share it with anyone.`,
    "",
    "If you did not request this login code, you can safely ignore this email.",
  ].join("\n");
}

async function getLatestCode(email) {
  if (!supabase) {
    return memStore.emailLoginCodes
      .filter((record) => record.email === email && !record.used_at)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
  }

  const { data, error } = await supabase
    .from("email_login_codes")
    .select("*")
    .eq("email", email)
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getActiveCodes(email) {
  const now = new Date().toISOString();
  if (!supabase) {
    return memStore.emailLoginCodes
      .filter((record) => record.email === email && !record.used_at && record.expires_at > now)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  const { data, error } = await supabase
    .from("email_login_codes")
    .select("*")
    .eq("email", email)
    .is("used_at", null)
    .gt("expires_at", now)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function invalidateOldCodes(email) {
  const now = new Date().toISOString();
  if (!supabase) {
    memStore.emailLoginCodes = memStore.emailLoginCodes.map((record) =>
      record.email === email && !record.used_at ? { ...record, used_at: now } : record
    );
    return;
  }
  const { error } = await supabase
    .from("email_login_codes")
    .update({ used_at: now })
    .eq("email", email)
    .is("used_at", null);
  if (error) throw error;
}

async function insertCode(record) {
  if (!supabase) {
    memStore.emailLoginCodes.push(record);
    return record;
  }
  const { data, error } = await supabase
    .from("email_login_codes")
    .insert(record)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateCode(id, patch) {
  if (!supabase) {
    memStore.emailLoginCodes = memStore.emailLoginCodes.map((record) =>
      record.id === id ? { ...record, ...patch } : record
    );
    return;
  }
  const { error } = await supabase
    .from("email_login_codes")
    .update(patch)
    .eq("id", id);
  if (error) throw error;
}

async function requestEmailCode(rawEmail) {
  const email = normalizeEmail(rawEmail);
  assertValidEmail(email);

  const latest = await getLatestCode(email);
  if (latest) {
    const ageSeconds = (Date.now() - new Date(latest.created_at).getTime()) / 1000;
    if (ageSeconds < OTP_RESEND_COOLDOWN_SECONDS) {
      throw Object.assign(new Error(`Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - ageSeconds)} seconds before requesting another code`), {
        status: 429,
      });
    }
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000).toISOString();
  const record = {
    id: crypto.randomUUID(),
    email,
    code_hash: hashCode(email, code),
    expires_at: expiresAt,
    used_at: null,
    attempt_count: 0,
    created_at: new Date().toISOString(),
  };
  await insertCode(record);

  await sendEmail({
    to: email,
    subject: "Your Cavo login code",
    html: buildEmailHtml(code),
    text: buildEmailText(code),
  });

  return {
    ok: true,
    email,
    expiresAt,
    cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

async function verifyEmailCode(rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || "").trim();
  assertValidEmail(email);
  if (!/^\d{6}$/.test(code)) {
    throw Object.assign(new Error("Enter the 6-digit code"), { status: 400 });
  }

  const records = await getActiveCodes(email);
  const record = records[0];
  if (!record) {
    throw Object.assign(new Error("Code expired or not found. Request a new code."), { status: 400 });
  }
  if (Number(record.attempt_count || 0) >= OTP_MAX_ATTEMPTS) {
    await updateCode(record.id, { used_at: new Date().toISOString() });
    throw Object.assign(new Error("Too many incorrect attempts. Request a new code."), { status: 429 });
  }

  const actualHash = hashCode(email, code);
  const matchingRecord = records.find((candidate) => candidate.code_hash === actualHash);
  if (!matchingRecord) {
    await updateCode(record.id, { attempt_count: Number(record.attempt_count || 0) + 1 });
    throw Object.assign(new Error("Invalid verification code"), { status: 400 });
  }

  await invalidateOldCodes(email);
  return { email };
}

module.exports = {
  requestEmailCode,
  verifyEmailCode,
};
