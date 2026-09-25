const crypto = require("crypto");
const { promisify } = require("util");
const { isValidAddressForChain, normalizeAccountAddress } = require("./arc");

const scrypt = promisify(crypto.scrypt);
const PIN_LENGTH = 4;
const APPROVAL_TTL_MS = 90 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000;
const MAX_SINGLE_SEND = Number(process.env.CAVO_MAX_SINGLE_SEND_USDC || 500);
const MAX_DAILY_SEND = Number(process.env.CAVO_MAX_DAILY_SEND_USDC || 2000);
const DEFAULT_DESTINATION_CHAIN = "Arc_Testnet";
const CAVO_RECOVERY_QUESTIONS = [
  "What city were you born in?",
  "What is the name of your first school?",
];
const PEPPER_MIN_LENGTH = 32;

let supabase = null;
const memoryPins = new Map();
const memoryApprovals = new Map();
const memoryAuditEvents = [];
let tableSupport = null;

function setSupabase(client) {
  supabase = client;
  tableSupport = null;
}

function normalizeUserKey(value) {
  return String(value || "").toLowerCase().trim();
}

function normalizeAddress(value) {
  return String(value || "").toLowerCase().trim();
}

function getPinPepper() {
  const pepper = String(process.env.CAVO_PIN_PEPPER || "").trim();
  if (pepper.length < PEPPER_MIN_LENGTH) {
    throw Object.assign(new Error("CAVO_PIN_PEPPER is not configured"), { status: 500 });
  }
  return pepper;
}

function buildPepperedSecret(kind, userKey, secret) {
  const normalizedUserKey = normalizeUserKey(userKey);
  if (!normalizedUserKey) throw Object.assign(new Error("Valid user key is required"), { status: 400 });
  return [
    "cavo",
    kind,
    normalizedUserKey,
    String(secret || ""),
    getPinPepper(),
  ].join(":");
}

function isValidPin(pin) {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(String(pin || ""));
}

function normalizeRecoveryQuestion(value) {
  return String(value || "").trim().slice(0, 160);
}

function normalizeRecoveryAnswer(value) {
  return String(value || "").trim().toLowerCase();
}

function parseRecoveryQuestions(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [String(value)];
  } catch {
    return [String(value)];
  }
}

function normalizeRecoveryAnswers(value, fallback) {
  const answers = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [value.answerOne, value.answerTwo]
      : fallback
        ? [fallback]
        : [];
  return answers.map(normalizeRecoveryAnswer).filter(Boolean);
}

function buildRecoverySecret(answers) {
  return answers.join("\n::cavo-security-answer::\n");
}

function normalizeAmount(value) {
  const text = String(value || "").trim();
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) return "";
  return number.toString();
}

function normalizeDestinationChain(value) {
  return String(value || DEFAULT_DESTINATION_CHAIN).trim();
}

async function supportsTables() {
  if (!supabase) return false;
  if (tableSupport !== null) return tableSupport;
  const { error } = await supabase.from("cavo_pins").select("user_key").limit(1);
  tableSupport = !error;
  return tableSupport;
}

async function hashSecret(secret, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = await scrypt(String(secret), salt, 64);
  return { salt, hash: derived.toString("hex") };
}

async function verifyHash(secret, salt, expectedHash) {
  const { hash } = await hashSecret(secret, salt);
  const left = Buffer.from(hash, "hex");
  const right = Buffer.from(expectedHash, "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function getPinRecord(userKey) {
  if (await supportsTables()) {
    const { data, error } = await supabase
      .from("cavo_pins")
      .select("*")
      .eq("user_key", userKey)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  return memoryPins.get(userKey) || null;
}

async function savePinRecord(record) {
  const now = new Date().toISOString();
  const next = { ...record, updated_at: now };
  if (await supportsTables()) {
    const { error } = await supabase
      .from("cavo_pins")
      .upsert(next, { onConflict: "user_key" });
    if (error) throw error;
    return next;
  }
  memoryPins.set(next.user_key, next);
  return next;
}

async function recordAudit(eventType, details = {}) {
  const event = {
    id: crypto.randomUUID(),
    event_type: eventType,
    user_key: normalizeUserKey(details.userKey),
    wallet_address: details.walletAddress ? normalizeAddress(details.walletAddress) : null,
    destination_address: details.destinationAddress ? normalizeAddress(details.destinationAddress) : null,
    amount: details.amount ? normalizeAmount(details.amount) : null,
    token: details.token ? String(details.token).toUpperCase() : null,
    metadata: {
      ...(details.metadata || {}),
      ...(details.destinationChain ? { destinationChain: normalizeDestinationChain(details.destinationChain) } : {}),
    },
    created_at: new Date().toISOString(),
  };

  if (await supportsTables()) {
    const { error } = await supabase.from("cavo_security_events").insert(event);
    if (error) {
      console.warn("Failed to write Cavo security event:", error.message);
    }
  } else {
    memoryAuditEvents.push(event);
  }
}

async function enforceSpendingLimits(userKey, amount) {
  const amountNumber = Number(amount);
  if (amountNumber > MAX_SINGLE_SEND) {
    throw Object.assign(new Error(`Single sends are limited to ${MAX_SINGLE_SEND} USDC right now`), { status: 400 });
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let approvals = [];
  if (await supportsTables()) {
    const { data, error } = await supabase
      .from("cavo_pin_approvals")
      .select("amount")
      .eq("user_key", userKey)
      .not("used_at", "is", null)
      .gte("created_at", since);
    if (error) throw error;
    approvals = data || [];
  } else {
    approvals = Array.from(memoryApprovals.values())
      .filter(approval => approval.user_key === userKey && approval.used_at && approval.created_at >= since);
  }

  const spent = approvals.reduce((total, approval) => total + Number(approval.amount || 0), 0);
  if (spent + amountNumber > MAX_DAILY_SEND) {
    throw Object.assign(new Error(`Daily sends are limited to ${MAX_DAILY_SEND} USDC right now`), { status: 400 });
  }
}

async function getPinStatus(userKey) {
  const record = await getPinRecord(normalizeUserKey(userKey));
  return {
    hasPin: !!record,
    hasRecoveryQuestion: !!record?.recovery_question,
    recoveryQuestion: record?.recovery_question || null,
    recoveryQuestions: parseRecoveryQuestions(record?.recovery_question),
  };
}

async function setupPin(userKey, pin, recoveryAnswers, fallbackRecoveryAnswer) {
  const normalizedUserKey = normalizeUserKey(userKey);
  if (!normalizedUserKey) throw Object.assign(new Error("Valid user key is required"), { status: 400 });
  if (!isValidPin(pin)) throw Object.assign(new Error("Cavo PIN must be 4 digits"), { status: 400 });
  const answers = normalizeRecoveryAnswers(recoveryAnswers, fallbackRecoveryAnswer);
  if (answers.length !== CAVO_RECOVERY_QUESTIONS.length || answers.some(answer => answer.length < 3)) {
    throw Object.assign(new Error("Answer both Cavo security questions"), { status: 400 });
  }

  const existing = await getPinRecord(normalizedUserKey);
  if (existing) throw Object.assign(new Error("Cavo PIN is already set"), { status: 409 });

  const { salt, hash } = await hashSecret(buildPepperedSecret("pin", normalizedUserKey, pin));
  const recovery = await hashSecret(buildPepperedSecret("recovery", normalizedUserKey, buildRecoverySecret(answers)));
  const now = new Date().toISOString();
  await savePinRecord({
    user_key: normalizedUserKey,
    pin_hash: hash,
    salt,
    recovery_question: JSON.stringify(CAVO_RECOVERY_QUESTIONS),
    recovery_answer_hash: recovery.hash,
    recovery_answer_salt: recovery.salt,
    failed_attempts: 0,
    locked_until: null,
    recovery_failed_attempts: 0,
    recovery_locked_until: null,
    created_at: now,
  });
  await recordAudit("pin_setup", { userKey: normalizedUserKey });
  return { hasPin: true };
}

async function verifyPinRecord(record, pin) {
  return isValidPin(pin) && await verifyHash(
    buildPepperedSecret("pin", record.user_key, pin),
    record.salt,
    record.pin_hash,
  );
}

async function changePin(payload) {
  const userKey = normalizeUserKey(payload.userKey);
  const currentPin = String(payload.currentPin || "");
  const newPin = String(payload.newPin || "");
  if (!userKey) throw Object.assign(new Error("Valid user key is required"), { status: 400 });
  if (!isValidPin(newPin)) throw Object.assign(new Error("New Cavo PIN must be 4 digits"), { status: 400 });

  const record = await getPinRecord(userKey);
  if (!record) throw Object.assign(new Error("Set your Cavo PIN first"), { status: 409, code: "PIN_NOT_SET" });

  const lockedUntil = record.locked_until ? new Date(record.locked_until).getTime() : 0;
  if (lockedUntil && lockedUntil > Date.now()) {
    throw Object.assign(new Error("Too many wrong PIN attempts. Try again later."), { status: 429 });
  }

  const ok = await verifyPinRecord(record, currentPin);
  if (!ok) {
    const failed = Number(record.failed_attempts || 0) + 1;
    const locked = failed >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
    await savePinRecord({ ...record, failed_attempts: failed, locked_until: locked });
    await recordAudit("pin_change_failed", { userKey, metadata: { failedAttempts: failed, locked: !!locked } });
    throw Object.assign(new Error(locked ? "Too many wrong PIN attempts. Try again later." : "Incorrect current PIN"), {
      status: locked ? 429 : 401,
    });
  }

  const { salt, hash } = await hashSecret(buildPepperedSecret("pin", userKey, newPin));
  await savePinRecord({ ...record, pin_hash: hash, salt, failed_attempts: 0, locked_until: null });
  await recordAudit("pin_changed", { userKey });
  return { ok: true };
}

async function setRecoveryQuestion(payload) {
  const userKey = normalizeUserKey(payload.userKey);
  const pin = String(payload.pin || "");
  const answers = normalizeRecoveryAnswers(payload.recoveryAnswers, payload.recoveryAnswer);
  if (!userKey) throw Object.assign(new Error("Valid user key is required"), { status: 400 });
  if (answers.length !== CAVO_RECOVERY_QUESTIONS.length || answers.some(answer => answer.length < 3)) {
    throw Object.assign(new Error("Answer both Cavo security questions"), { status: 400 });
  }

  const record = await getPinRecord(userKey);
  if (!record) throw Object.assign(new Error("Set your Cavo PIN first"), { status: 409, code: "PIN_NOT_SET" });
  if (!await verifyPinRecord(record, pin)) throw Object.assign(new Error("Incorrect Payment PIN"), { status: 401 });

  const recovery = await hashSecret(buildPepperedSecret("recovery", userKey, buildRecoverySecret(answers)));
  await savePinRecord({
    ...record,
    recovery_question: JSON.stringify(CAVO_RECOVERY_QUESTIONS),
    recovery_answer_hash: recovery.hash,
    recovery_answer_salt: recovery.salt,
    recovery_failed_attempts: 0,
    recovery_locked_until: null,
  });
  await recordAudit("pin_recovery_question_set", { userKey });
  return { ok: true, hasRecoveryQuestion: true, recoveryQuestion: JSON.stringify(CAVO_RECOVERY_QUESTIONS), recoveryQuestions: CAVO_RECOVERY_QUESTIONS };
}

async function recoverPin(payload) {
  const userKey = normalizeUserKey(payload.userKey);
  const answers = normalizeRecoveryAnswers(payload.recoveryAnswers, payload.recoveryAnswer);
  const newPin = String(payload.newPin || "");
  if (!userKey) throw Object.assign(new Error("Valid user key is required"), { status: 400 });
  if (!isValidPin(newPin)) throw Object.assign(new Error("New Cavo PIN must be 4 digits"), { status: 400 });
  if (answers.length !== CAVO_RECOVERY_QUESTIONS.length || answers.some(answer => answer.length < 3)) {
    throw Object.assign(new Error("Answer both Cavo security questions"), { status: 400 });
  }

  const record = await getPinRecord(userKey);
  if (!record?.recovery_question || !record.recovery_answer_hash || !record.recovery_answer_salt) {
    throw Object.assign(new Error("No security question is set for this account"), { status: 409 });
  }

  const lockedUntil = record.recovery_locked_until ? new Date(record.recovery_locked_until).getTime() : 0;
  if (lockedUntil && lockedUntil > Date.now()) {
    throw Object.assign(new Error("Too many wrong recovery attempts. Try again later."), { status: 429 });
  }

  const ok = await verifyHash(
    buildPepperedSecret("recovery", userKey, buildRecoverySecret(answers)),
    record.recovery_answer_salt,
    record.recovery_answer_hash,
  );
  if (!ok) {
    const failed = Number(record.recovery_failed_attempts || 0) + 1;
    const locked = failed >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
    await savePinRecord({ ...record, recovery_failed_attempts: failed, recovery_locked_until: locked });
    await recordAudit("pin_recovery_failed", { userKey, metadata: { failedAttempts: failed, locked: !!locked } });
    throw Object.assign(new Error(locked ? "Too many wrong recovery attempts. Try again later." : "Incorrect security answer"), {
      status: locked ? 429 : 401,
    });
  }

  const { salt, hash } = await hashSecret(buildPepperedSecret("pin", userKey, newPin));
  await savePinRecord({
    ...record,
    pin_hash: hash,
    salt,
    failed_attempts: 0,
    locked_until: null,
    recovery_failed_attempts: 0,
    recovery_locked_until: null,
  });
  await recordAudit("pin_recovered", { userKey });
  return { ok: true };
}

async function createApproval(payload) {
  const userKey = normalizeUserKey(payload.userKey);
  const pin = String(payload.pin || "");
  const walletAddress = normalizeAddress(payload.walletAddress);
  const walletId = String(payload.walletId || "").trim();
  const destinationChain = normalizeDestinationChain(payload.destinationChain);
  // Chain-aware: EVM lowercases, Solana base58 is case-sensitive (never touch).
  const destinationAddress = normalizeAccountAddress(destinationChain, payload.destinationAddress);
  // Cross-chain bridge leg (earn withdrawals): only bound when explicitly
  // provided; "Arc_Testnet" means no bridge.
  const bridgeTo = payload.bridgeTo && payload.bridgeTo !== DEFAULT_DESTINATION_CHAIN ? String(payload.bridgeTo).trim() : null;
  const bridgeAddress = bridgeTo ? normalizeAccountAddress(bridgeTo, payload.bridgeAddress) : null;
  const amount = normalizeAmount(payload.amount);
  const transactionType = String(payload.transactionType || "send").toLowerCase();
  const token = String(payload.token || "USDC").toUpperCase();
  const tokenOut = payload.tokenOut ? String(payload.tokenOut).toUpperCase() : "";
  const approvalToken = transactionType === "swap" ? `${token}->${tokenOut}` : token;

  if (!userKey || !walletAddress || !walletId || !destinationAddress || !amount) {
    throw Object.assign(new Error("Approval requires user, wallet, recipient, and amount"), { status: 400 });
  }
  if (!/^0x[a-f0-9]{40}$/.test(walletAddress)) {
    throw Object.assign(new Error("Approval requires a valid wallet address"), { status: 400 });
  }
  if (!isValidAddressForChain(destinationChain, destinationAddress)) {
    throw Object.assign(new Error("Approval destination does not match the destination chain format"), { status: 400 });
  }
  if (bridgeTo && !isValidAddressForChain(bridgeTo, bridgeAddress)) {
    throw Object.assign(new Error("Bridge destination does not match the bridge chain format"), { status: 400 });
  }
  if (transactionType === "earn" && bridgeTo && token !== "USDC") {
    throw Object.assign(new Error("Cross-chain earn withdrawals are USDC-only (Circle CCTP)"), { status: 400 });
  }
  if (!["send", "swap", "earn"].includes(transactionType)) {
    throw Object.assign(new Error("Unsupported approval type"), { status: 400 });
  }
  if (!["USDC", "EURC"].includes(token)) {
    throw Object.assign(new Error("Only USDC and EURC sends are supported right now"), { status: 400 });
  }
  if (transactionType === "earn") {
    // Earn approvals may only target known vault contracts, never arbitrary addresses.
    let isVault = false;
    try {
      isVault = require("./earn").isKnownVaultAddress(destinationAddress);
    } catch {
      isVault = false;
    }
    if (!isVault) {
      throw Object.assign(new Error("Earn deposits are only supported for listed vaults"), { status: 400 });
    }
    if (destinationChain !== DEFAULT_DESTINATION_CHAIN) {
      throw Object.assign(new Error("Earn is only supported on Arc Testnet"), { status: 400 });
    }
  }
  if (transactionType === "swap" && (!["USDC", "EURC"].includes(tokenOut) || tokenOut === token)) {
    throw Object.assign(new Error("Swap must be between USDC and EURC"), { status: 400 });
  }
  if (transactionType === "swap" && destinationChain !== DEFAULT_DESTINATION_CHAIN) {
    throw Object.assign(new Error("Swaps are only supported on Arc Testnet"), { status: 400 });
  }
  if (transactionType === "send" && token === "EURC" && destinationChain !== DEFAULT_DESTINATION_CHAIN) {
    throw Object.assign(new Error("EURC sends are only supported on Arc Testnet"), { status: 400 });
  }
  await enforceSpendingLimits(userKey, amount);

  const record = await getPinRecord(userKey);
  if (!record) throw Object.assign(new Error("Set your Cavo PIN before sending"), { status: 409, code: "PIN_NOT_SET" });

  const lockedUntil = record.locked_until ? new Date(record.locked_until).getTime() : 0;
  if (lockedUntil && lockedUntil > Date.now()) {
    throw Object.assign(new Error("Too many wrong PIN attempts. Try again later."), { status: 429 });
  }

  const ok = isValidPin(pin) && await verifyHash(
    buildPepperedSecret("pin", userKey, pin),
    record.salt,
    record.pin_hash,
  );
  if (!ok) {
    const failed = Number(record.failed_attempts || 0) + 1;
    const locked = failed >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
    await savePinRecord({ ...record, failed_attempts: failed, locked_until: locked });
    await recordAudit("pin_approval_failed", {
      userKey,
      walletAddress,
      destinationAddress,
      destinationChain,
      amount,
      token: approvalToken,
      metadata: { failedAttempts: failed, locked: !!locked, transactionType },
    });
    throw Object.assign(new Error(locked ? "Too many wrong PIN attempts. Try again later." : "Incorrect Cavo PIN"), {
      status: locked ? 429 : 401,
    });
  }

  await savePinRecord({ ...record, failed_attempts: 0, locked_until: null });

  const approval = {
    id: crypto.randomUUID(),
    user_key: userKey,
    wallet_address: walletAddress,
    wallet_id: walletId,
    destination_address: destinationAddress,
    destination_chain: destinationChain,
    amount,
    token: approvalToken,
    expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    used_at: null,
    created_at: new Date().toISOString(),
    // Only persisted when set so Arc-only approvals keep working before the
    // 12_bridge_binding.sql migration adds the columns.
    ...(bridgeTo ? { bridge_to: bridgeTo, bridge_address: bridgeAddress } : {}),
  };

  if (await supportsTables()) {
    const { error } = await supabase.from("cavo_pin_approvals").insert(approval);
    if (error) throw error;
  } else {
    memoryApprovals.set(approval.id, approval);
  }

  await recordAudit("pin_approval_created", {
    userKey,
    walletAddress,
    destinationAddress,
    destinationChain,
    amount,
    token: approvalToken,
    metadata: { approvalId: approval.id, expiresAt: approval.expires_at, transactionType, ...(bridgeTo ? { bridgeTo, bridgeAddress } : {}) },
  });

  return { approvalId: approval.id, expiresAt: approval.expires_at };
}

async function consumeApproval(payload) {
  const approvalId = String(payload.approvalId || "").trim();
  if (!approvalId) throw Object.assign(new Error("Cavo PIN approval is required"), { status: 401 });

  let approval;
  if (await supportsTables()) {
    const { data, error } = await supabase
      .from("cavo_pin_approvals")
      .select("*")
      .eq("id", approvalId)
      .maybeSingle();
    if (error) throw error;
    approval = data;
  } else {
    approval = memoryApprovals.get(approvalId);
  }

  if (!approval) throw Object.assign(new Error("Cavo PIN approval was not found"), { status: 401 });
  if (approval.used_at) throw Object.assign(new Error("Cavo PIN approval was already used"), { status: 401 });
  if (new Date(approval.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error("Cavo PIN approval expired. Enter PIN again."), { status: 401 });
  }

  const expectedChain = normalizeDestinationChain(payload.destinationChain);
  const expected = {
    userKey: normalizeUserKey(payload.userKey),
    walletAddress: normalizeAddress(payload.walletAddress),
    walletId: String(payload.walletId || "").trim(),
    destinationAddress: normalizeAccountAddress(expectedChain, payload.destinationAddress),
    destinationChain: expectedChain,
    amount: normalizeAmount(payload.amount),
    token: payload.tokenOut
      ? `${String(payload.token || "USDC").toUpperCase()}->${String(payload.tokenOut).toUpperCase()}`
      : String(payload.token || "USDC").toUpperCase(),
  };

  // Bridge leg binding: a bridge may only run when the approval covered it,
  // and then the destination must match exactly.
  const approvalBridgeTo = approval.bridge_to || null;
  const expectedBridgeTo = payload.bridgeTo && payload.bridgeTo !== DEFAULT_DESTINATION_CHAIN ? String(payload.bridgeTo).trim() : null;
  const expectedBridgeAddress = expectedBridgeTo ? normalizeAccountAddress(expectedBridgeTo, payload.bridgeAddress) : null;
  const bridgeMatches = approvalBridgeTo
    ? expectedBridgeTo === approvalBridgeTo && expectedBridgeAddress === (approval.bridge_address || null)
    : !expectedBridgeTo;

  const matches =
    approval.user_key === expected.userKey &&
    approval.wallet_address === expected.walletAddress &&
    approval.wallet_id === expected.walletId &&
    approval.destination_address === expected.destinationAddress &&
    (approval.destination_chain || DEFAULT_DESTINATION_CHAIN) === expected.destinationChain &&
    approval.amount === expected.amount &&
    approval.token === expected.token &&
    bridgeMatches;

  if (!matches) throw Object.assign(new Error("Cavo PIN approval does not match this transaction"), { status: 401 });

  const usedAt = new Date().toISOString();
  if (await supportsTables()) {
    // Require the conditional update to actually flip the row: a concurrent
    // consume must lose here, or one approval could execute twice.
    const { data, error } = await supabase
      .from("cavo_pin_approvals")
      .update({ used_at: usedAt })
      .eq("id", approvalId)
      .is("used_at", null)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      throw Object.assign(new Error("Cavo PIN approval was already used"), { status: 401 });
    }
  } else {
    const current = memoryApprovals.get(approvalId);
    if (!current || current.used_at) {
      throw Object.assign(new Error("Cavo PIN approval was already used"), { status: 401 });
    }
    memoryApprovals.set(approval.id, { ...approval, used_at: usedAt });
  }

  await recordAudit("pin_approval_consumed", {
    userKey: expected.userKey,
    walletAddress: expected.walletAddress,
    destinationAddress: expected.destinationAddress,
    destinationChain: expected.destinationChain,
    amount: expected.amount,
    token: expected.token,
    metadata: { approvalId },
  });

  return { ok: true };
}

module.exports = {
  changePin,
  consumeApproval,
  createApproval,
  getPinStatus,
  recoverPin,
  setSupabase,
  setRecoveryQuestion,
  setupPin,
};
