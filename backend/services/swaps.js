const circleSwapService = require("./circle-swaps");
const towerService = require("./tower");
const { SOURCE_CHAIN } = require("./arc");

const SUPPORTED_TOKENS = ["USDC", "EURC"];
const MAX_AMOUNT = 1_000_000_000;

let supabase = null;
const memorySwaps = new Map();

function setSupabase(client) {
  supabase = client;
}

function normalizeToken(value) {
  return String(value || "").toUpperCase().trim();
}

function normalizeAmount(value) {
  const number = Number(String(value || "").trim());
  if (!Number.isFinite(number) || number <= 0) {
    throw Object.assign(new Error("A valid swap amount is required"), { status: 400 });
  }
  if (number > MAX_AMOUNT) {
    throw Object.assign(new Error(`Swap amount is limited to ${MAX_AMOUNT}`), { status: 400 });
  }
  return number.toString();
}

function validateSwapPair(tokenIn, tokenOut) {
  if (!SUPPORTED_TOKENS.includes(tokenIn) || !SUPPORTED_TOKENS.includes(tokenOut)) {
    throw Object.assign(new Error("Swaps are limited to USDC and EURC"), { status: 400 });
  }
  if (tokenIn === tokenOut) {
    throw Object.assign(new Error("Choose two different tokens to swap"), { status: 400 });
  }
}

function getProviderName() {
  const provider = String(process.env.SWAP_PROVIDER || "circle").toLowerCase().trim();
  if (!["circle", "tower"].includes(provider)) {
    throw Object.assign(new Error("SWAP_PROVIDER must be 'circle' or 'tower'"), { status: 500 });
  }
  return provider;
}

async function getSwapQuote({ tokenIn, tokenOut, amountIn, walletAddress }) {
  const tokenInNormalized = normalizeToken(tokenIn);
  const tokenOutNormalized = normalizeToken(tokenOut);
  const amountNormalized = normalizeAmount(amountIn);
  validateSwapPair(tokenInNormalized, tokenOutNormalized);

  const provider = getProviderName();
  const quoteArgs = {
    tokenIn: tokenInNormalized,
    tokenOut: tokenOutNormalized,
    amountIn: amountNormalized,
    walletAddress,
  };
  return provider === "tower" ? towerService.getQuote(quoteArgs) : circleSwapService.getQuote(quoteArgs);
}

async function executeSwap({ provider, walletAddress, tokenIn, tokenOut, amountIn, minOut }) {
  const args = { walletAddress, tokenIn, tokenOut, amountIn, minOut };
  return provider === "tower" ? towerService.executeSwap(args) : circleSwapService.executeSwap(args);
}

async function getWalletForUser(userKey) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_wallets")
    .select("*")
    .eq("user_address", String(userKey).toLowerCase().trim())
    .eq("wallet_type", "developer_controlled")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function createSwapRecord(record) {
  if (!supabase) {
    memorySwaps.set(record.id, { ...record });
    return record;
  }
  const { error } = await supabase.from("swaps").insert(record);
  if (error) throw error;
  return record;
}

async function updateSwapRecord(id, patch) {
  if (!supabase) {
    const existing = memorySwaps.get(id);
    if (existing) memorySwaps.set(id, { ...existing, ...patch, updated_at: new Date().toISOString() });
    return;
  }
  const { error } = await supabase.from("swaps").update(patch).eq("id", id);
  if (error) console.warn("Failed to update swap record:", error.message);
}

async function listSwapsForUser(userKey) {
  const normalized = String(userKey).toLowerCase().trim();
  if (!supabase) {
    return Array.from(memorySwaps.values())
      .filter(record => record.user_key === normalized)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 50);
  }
  const { data, error } = await supabase
    .from("swaps")
    .select("*")
    .eq("user_key", normalized)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

module.exports = {
  SOURCE_CHAIN,
  createSwapRecord,
  executeSwap,
  getProviderName,
  getSwapQuote,
  getWalletForUser,
  listSwapsForUser,
  setSupabase,
  updateSwapRecord,
  validateSwapPair,
};
