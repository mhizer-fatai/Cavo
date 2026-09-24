/**
 * Earn service — ArcLend ERC-4626 vaults (alvUSDC / alvEURC) on Arc Testnet.
 *
 * Real DeFi integration: deposits are real USDC/EURC moved on-chain into live
 * third-party vaults via the user's Circle developer-controlled wallet, and
 * yield accrues as the vault share price appreciates. ArcLend is an unaudited
 * community protocol, so every surface is labeled experimental and deposits
 * are capped. When audited venues (Aave V4, Morpho) deploy on Arc, only the
 * VAULTS table and this service's execution layer need to change.
 */
const { executeContractCall, waitForTransactionHash } = require("./wallets");

const { bridgeUsdcFromArc, SOURCE_CHAIN } = require("./arc");
const USDC_ADDRESS = process.env.ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const EURC_ADDRESS = process.env.ARC_EURC_ADDRESS || "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

const VAULTS = {
  USDC: {
    token: "USDC",
    asset: USDC_ADDRESS,
    vault: process.env.EARN_ALVUSDC_VAULT || "0x363C4eE3CfD814D3CC3bc72aCe4259453cF651EB",
    shareSymbol: "alvUSDC",
    provider: "ArcLend",
    experimental: true,
  },
  EURC: {
    token: "EURC",
    asset: EURC_ADDRESS,
    vault: process.env.EARN_ALVEURC_VAULT || "0xf9A7CD2c92CB6957ECeFffE2881c5Bd163a2CAeD",
    shareSymbol: "alvEURC",
    provider: "ArcLend",
    experimental: true,
  },
};

const TOKEN_DECIMALS = 6;
const MAX_EARN_PER_TX = Number(process.env.EARN_MAX_PER_TX || 100);

const ARC_RPC_URLS = [
  process.env.ARC_RPC_URL,
  "https://rpc.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
  "https://arc-testnet.drpc.org",
].filter(Boolean);

let supabase = null;
const memoryPositions = new Map(); // `${userKey}|${token}` -> position
const memoryEvents = []; // earn events, newest last
const memorySnapshots = new Map(); // vault -> [{ sharePrice, recordedAt }]
const lastGoodVaults = new Map(); // shareSymbol -> last successfully fetched vault
// Once Supabase reports a missing earn table, use the in-memory store instead
// of failing every request (dev only; data is lost on server restart).
let useMemoryStore = false;

function setSupabase(client) {
  supabase = client;
}

function db() {
  return !supabase || useMemoryStore ? null : supabase;
}

function noteMissingTable(error) {
  const code = error?.code || "";
  const message = String(error?.message || "");
  if (code === "PGRST205" || /could not find the table|schema cache/i.test(message)) {
    if (!useMemoryStore) {
      console.warn("Earn tables are missing in Supabase; falling back to in-memory store. Run the earn migration SQL to persist data.");
      useMemoryStore = true;
    }
    return true;
  }
  return false;
}

async function withDbFallback(memoryFn, dbFn) {
  const client = db();
  if (!client) return memoryFn();
  try {
    return await dbFn(client);
  } catch (err) {
    if (noteMissingTable(err)) return memoryFn();
    throw err;
  }
}

function getVault(token) {
  const normalized = String(token || "").toUpperCase().trim();
  const vault = VAULTS[normalized];
  if (!vault) throw Object.assign(new Error("Earn is available for USDC and EURC"), { status: 400 });
  return vault;
}

function isKnownVaultAddress(address) {
  const normalized = String(address || "").toLowerCase();
  return Object.values(VAULTS).some(entry => entry.vault.toLowerCase() === normalized);
}

function normalizeAmount(value) {
  const number = Number(String(value || "").trim());
  if (!Number.isFinite(number) || number <= 0) {
    throw Object.assign(new Error("A valid earn amount is required"), { status: 400 });
  }
  if (number > MAX_EARN_PER_TX) {
    throw Object.assign(new Error(`Earn transactions are limited to ${MAX_EARN_PER_TX} per transaction (testnet safety cap)`), { status: 400 });
  }
  return number;
}

function toAtomic(amount) {
  return BigInt(Math.round(Number(amount) * 10 ** TOKEN_DECIMALS)).toString();
}

function fromAtomic(value) {
  return Number(value) / 10 ** TOKEN_DECIMALS;
}

function padAddress(address) {
  return String(address).toLowerCase().slice(2).padStart(64, "0");
}

function padUint(value) {
  return BigInt(String(value)).toString(16).padStart(64, "0");
}

async function rpcCall(method, params, timeoutMs = 10000, attemptsPerEndpoint = 2) {
  let lastError;
  for (const baseUrl of ARC_RPC_URLS) {
    for (let attempt = 0; attempt < attemptsPerEndpoint; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
        if (payload && payload.error) throw new Error(payload.error.message || "RPC error");
        return payload ? payload.result : undefined;
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastError || new Error("All Arc RPC endpoints failed");
}

async function ethCall(to, data) {
  return rpcCall("eth_call", [{ to, data }, "latest"]);
}

// ERC-4626 selectors.
const SEL_TOTAL_ASSETS = "0x01e1d114";
const SEL_TOTAL_SUPPLY = "0x18160ddd";
const SEL_BALANCE_OF = "0x70a08231";
const SEL_PREVIEW_DEPOSIT = "0xef8b30f7";
const SEL_PREVIEW_REDEEM = "0x4cd317b9";
const SEL_MAX_DEPOSIT = "0xd6c67a46";
const SEL_MAX_REDEEM = "0xd905777e";

/**
 * Minimal verified ABI reference for the integrated vaults (ArcLend alvUSDC/alvEURC,
 * standard ERC-4626 + ERC-20). The backend signs calls through Circle contract
 * execution using abiFunctionSignature strings; reads below use raw selectors.
 *
 * ERC-20 (asset): approve(address spender, uint256 amount) -> bool
 * ERC-4626 (vault):
 *   asset() -> address
 *   totalAssets() -> uint256
 *   totalSupply() -> uint256
 *   balanceOf(address) -> uint256
 *   previewDeposit(uint256 assets) -> uint256 shares
 *   previewRedeem(uint256 shares) -> uint256 assets
 *   maxDeposit(address receiver) -> uint256
 *   maxRedeem(address owner) -> uint256
 *   deposit(uint256 assets, address receiver) -> uint256 shares
 *   redeem(uint256 shares, address receiver, address owner) -> uint256 assets
 */

async function getVaultState(vaultAddress) {
  const [assetsHex, supplyHex] = await Promise.all([
    ethCall(vaultAddress, SEL_TOTAL_ASSETS),
    ethCall(vaultAddress, SEL_TOTAL_SUPPLY),
  ]);
  const totalAssets = BigInt(assetsHex || "0x0");
  const totalSupply = BigInt(supplyHex || "0x0");
  // Share price scaled by 1e18 (1e18 == 1.0 when empty).
  const sharePrice = totalSupply > 0n ? (totalAssets * 10n ** 18n) / totalSupply : 10n ** 18n;
  return {
    totalAssets: fromAtomic(totalAssets.toString()),
    totalSupply: fromAtomic(totalSupply.toString()),
    sharePrice: Number(sharePrice) / 1e18,
  };
}

async function getShareBalance(vaultAddress, walletAddress) {
  const result = await ethCall(vaultAddress, `${SEL_BALANCE_OF}${padAddress(walletAddress)}`);
  return fromAtomic((BigInt(result || "0x0")).toString());
}

async function previewDeposit(vaultAddress, amountAtomic) {
  const result = await ethCall(vaultAddress, `${SEL_PREVIEW_DEPOSIT}${padUint(amountAtomic)}`);
  return fromAtomic((BigInt(result || "0x0")).toString());
}

async function previewRedeem(vaultAddress, sharesAtomic) {
  const result = await ethCall(vaultAddress, `${SEL_PREVIEW_REDEEM}${padUint(sharesAtomic)}`);
  return fromAtomic((BigInt(result || "0x0")).toString());
}

async function recordSnapshot(vaultAddress, state) {
  const entry = { sharePrice: state.sharePrice, recordedAt: new Date().toISOString() };
  const memoryFn = () => {
    const list = memorySnapshots.get(vaultAddress) || [];
    const last = list[list.length - 1];
    // Throttle: at most one snapshot per hour in memory.
    if (last && Date.now() - new Date(last.recordedAt).getTime() < 3600_000) return list;
    list.push(entry);
    memorySnapshots.set(vaultAddress, list.slice(-200));
    return list;
  };
  const fetchSnapshots = async client => {
    const { data } = await client
      .from("earn_vault_snapshots")
      .select("share_price, recorded_at")
      .eq("vault", vaultAddress.toLowerCase())
      .order("recorded_at", { ascending: true });
    return (data || []).map(row => ({ sharePrice: Number(row.share_price), recordedAt: row.recorded_at }));
  };
  return withDbFallback(memoryFn, async client => {
    const { data: latest } = await client
      .from("earn_vault_snapshots")
      .select("recorded_at")
      .eq("vault", vaultAddress.toLowerCase())
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest || Date.now() - new Date(latest.recorded_at).getTime() >= 3600_000) {
      await client.from("earn_vault_snapshots").insert({
        vault: vaultAddress.toLowerCase(),
        share_price: state.sharePrice,
        total_assets: state.totalAssets,
        total_supply: state.totalSupply,
      });
    }
    return fetchSnapshots(client);
  });
}

function apyFromSnapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return { apy: null, periodDays: null };
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const elapsedMs = new Date(last.recordedAt).getTime() - new Date(first.recordedAt).getTime();
  if (!(elapsedMs > 0) || !(first.sharePrice > 0)) return { apy: null, periodDays: null };
  const growth = last.sharePrice / first.sharePrice;
  if (!(growth > 0)) return { apy: null, periodDays: null };
  const years = elapsedMs / (365 * 24 * 3600 * 1000);
  return { apy: growth ** (1 / years) - 1, periodDays: elapsedMs / (24 * 3600 * 1000) };
}

async function getVaults(walletAddress) {
  // One vault's RPC blip must never take down the other: fetch independently
  // and fall back to the last-known-good snapshot when everything fails.
  const settled = await Promise.all(
    Object.values(VAULTS).map(async entry => {
      try {
        const state = await getVaultState(entry.vault);
        let snapshots = [];
        try {
          snapshots = await recordSnapshot(entry.vault, state);
        } catch (err) {
          console.warn("Earn snapshot failed:", err.message || err);
        }
        const { apy, periodDays } = apyFromSnapshots(snapshots);
        const vault = {
          id: entry.shareSymbol,
          token: entry.token,
          asset: entry.asset,
          vault: entry.vault,
          provider: entry.provider,
          experimental: entry.experimental,
          totalAssets: state.totalAssets,
          totalSupply: state.totalSupply,
          sharePrice: state.sharePrice,
          apy,
          apyPeriodDays: periodDays,
          stale: false,
        };
        // Per-wallet limits so the UI can gate deposits (e.g. paused vaults
        // report maxDeposit 0) and show the user's share balance.
        if (walletAddress && /^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
          try {
            const [maxDepositHex, maxRedeemHex, shareBalance] = await Promise.all([
              ethCall(entry.vault, `${SEL_MAX_DEPOSIT}${padAddress(walletAddress)}`),
              ethCall(entry.vault, `${SEL_MAX_REDEEM}${padAddress(walletAddress)}`),
              getShareBalance(entry.vault, walletAddress),
            ]);
            vault.maxDeposit = fromAtomic((BigInt(maxDepositHex || "0x0")).toString());
            vault.maxRedeem = fromAtomic((BigInt(maxRedeemHex || "0x0")).toString());
            vault.shareBalance = shareBalance;
          } catch (err) {
            console.warn("Earn wallet limits failed:", err.message || err);
          }
        }
        lastGoodVaults.set(entry.shareSymbol, { ...vault, stale: false });
        return vault;
      } catch (err) {
        console.warn(`Earn vault ${entry.shareSymbol} fetch failed:`, err.message || err);
        const cached = lastGoodVaults.get(entry.shareSymbol);
        return cached ? { ...cached, stale: true } : null;
      }
    }),
  );
  const vaults = settled.filter(Boolean);
  if (vaults.length === 0) {
    throw Object.assign(new Error("Earn vaults are unreachable right now. Try again in a moment."), { status: 502 });
  }
  return vaults;
}

async function getPositions(userKey) {
  const normalized = String(userKey).toLowerCase().trim();
  return withDbFallback(
    () => Array.from(memoryPositions.values()).filter(row => row.user_key === normalized),
    async client => {
      const { data, error } = await client
        .from("earn_positions")
        .select("*")
        .eq("user_key", normalized);
      if (error) throw error;
      return data || [];
    },
  );
}

async function listEvents(userKey, limit = 50) {
  const normalized = String(userKey).toLowerCase().trim();
  return withDbFallback(
    () => memoryEvents.filter(event => event.user_key === normalized).slice(-limit).reverse(),
    async client => {
      const { data, error } = await client
        .from("earn_events")
        .select("*")
        .eq("user_key", normalized)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    },
  );
}

async function upsertPosition({ userKey, walletAddress, token, vault, sharesDelta, principalDelta }) {
  const key = `${String(userKey).toLowerCase().trim()}|${token}`;
  const memoryFn = () => {
    const existing = memoryPositions.get(key) || {
      user_key: String(userKey).toLowerCase().trim(),
      wallet_address: walletAddress.toLowerCase(),
      token,
      vault: vault.toLowerCase(),
      shares: 0,
      principal: 0,
    };
    existing.shares = Number(existing.shares) + Number(sharesDelta);
    existing.principal = Number(existing.principal) + Number(principalDelta);
    existing.updated_at = new Date().toISOString();
    if (existing.shares <= 1e-9) memoryPositions.delete(key);
    else memoryPositions.set(key, existing);
    return existing;
  };
  return withDbFallback(memoryFn, async client => {
    const { data: existing } = await client
      .from("earn_positions")
      .select("*")
      .eq("user_key", String(userKey).toLowerCase().trim())
      .eq("token", token)
      .maybeSingle();
    const shares = Number(existing?.shares || 0) + Number(sharesDelta);
    const principal = Number(existing?.principal || 0) + Number(principalDelta);
    if (shares <= 1e-9) {
      if (existing) await client.from("earn_positions").delete().eq("id", existing.id);
      return null;
    }
    const row = {
      user_key: String(userKey).toLowerCase().trim(),
      wallet_address: walletAddress.toLowerCase(),
      token,
      vault: vault.toLowerCase(),
      shares,
      principal,
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      const { error } = await client.from("earn_positions").update(row).eq("id", existing.id);
      if (error) throw error;
      return { ...existing, ...row };
    }
    const { data, error } = await client.from("earn_positions").insert(row).select().single();
    if (error) throw error;
    return data;
  });
}

async function recordEvent(event) {
  const row = { ...event, created_at: new Date().toISOString() };
  return withDbFallback(
    () => {
      memoryEvents.push({ ...row, id: row.id || `mem-${Date.now()}-${memoryEvents.length}` });
      return row;
    },
    async client => {
      const { error } = await client.from("earn_events").insert(row);
      if (error) throw error;
      return row;
    },
  );
}

async function deposit({ walletId, walletAddress, token, amount }) {
  const entry = getVault(token);
  const amountNumber = normalizeAmount(amount);
  const amountAtomic = toAtomic(amountNumber);
  const expectedShares = await previewDeposit(entry.vault, amountAtomic);

  const approveTx = await executeContractCall(walletId, entry.asset, "approve(address,uint256)", [
    entry.vault,
    amountAtomic,
  ]);
  const approveHash = await waitForTransactionHash(approveTx);
  if (!approveHash) {
    throw Object.assign(new Error("Vault approval was submitted but no transaction hash was returned. Check the explorer before retrying."), { status: 502 });
  }

  const depositTx = await executeContractCall(walletId, entry.vault, "deposit(uint256,address)", [
    amountAtomic,
    walletAddress.toLowerCase(),
  ]);
  const depositHash = await waitForTransactionHash(depositTx);
  if (!depositHash) {
    throw Object.assign(new Error("Vault deposit was submitted but no transaction hash was returned. Check the explorer before retrying."), { status: 502 });
  }

  return { approveHash, depositHash, shares: expectedShares, amount: amountNumber };
}

async function withdraw({ walletId, walletAddress, token, shares, destinationChain, destinationAddress }) {
  const entry = getVault(token);
  const sharesNumber = Number(String(shares || "").trim());
  if (!Number.isFinite(sharesNumber) || sharesNumber <= 0) {
    throw Object.assign(new Error("A valid share amount is required"), { status: 400 });
  }
  const bridgeTo = destinationChain && destinationChain !== "Arc_Testnet" ? destinationChain : null;
  if (bridgeTo && token !== "USDC") {
    // Circle CCTP only moves USDC; EURC must exit on Arc.
    throw Object.assign(new Error("Cross-chain withdrawals are USDC-only (Circle CCTP). Withdraw EURC to Arc Testnet."), { status: 400 });
  }
  const bridgeRecipient = (destinationAddress || walletAddress).toLowerCase();
  if (bridgeTo && !/^0x[a-f0-9]{40}$/.test(bridgeRecipient)) {
    throw Object.assign(new Error("A valid destination address is required"), { status: 400 });
  }
  const onchainShares = await getShareBalance(entry.vault, walletAddress);
  if (onchainShares + 1e-9 < sharesNumber) {
    throw Object.assign(new Error(`Insufficient vault shares (have ${onchainShares.toFixed(6)}, tried to withdraw ${sharesNumber})`), { status: 400 });
  }
  const sharesAtomic = BigInt(Math.round(sharesNumber * 10 ** TOKEN_DECIMALS)).toString();
  const expectedAssets = await previewRedeem(entry.vault, sharesAtomic);

  const redeemTx = await executeContractCall(walletId, entry.vault, "redeem(uint256,address,address)", [
    sharesAtomic,
    walletAddress.toLowerCase(),
    walletAddress.toLowerCase(),
  ]);
  const redeemHash = await waitForTransactionHash(redeemTx);
  if (!redeemHash) {
    throw Object.assign(new Error("Vault withdrawal was submitted but no transaction hash was returned. Check the explorer before retrying."), { status: 502 });
  }

  // Optional second leg: bridge the redeemed USDC to another chain via Circle CCTP.
  // This runs under the same PIN approval that authorized the vault redeem;
  // the UI discloses the full redeem + bridge operation before approval.
  let bridgeHash = null;
  let bridgeState = null;
  if (bridgeTo) {
    const bridge = await bridgeUsdcFromArc({
      fromAddress: walletAddress.toLowerCase(),
      toAddress: bridgeRecipient,
      destinationChain: bridgeTo,
      amount: String(expectedAssets),
    });
    bridgeHash = bridge.txHash || null;
    bridgeState = bridge.state || "pending";
  }

  return {
    redeemHash,
    bridgeHash,
    bridgeState,
    destinationChain: bridgeTo || "Arc_Testnet",
    destinationAddress: bridgeTo ? bridgeRecipient : walletAddress.toLowerCase(),
    assets: expectedAssets,
    shares: sharesNumber,
  };
}

module.exports = {
  VAULTS,
  MAX_EARN_PER_TX,
  SOURCE_CHAIN: "Arc_Testnet",
  deposit,
  getPositions,
  getShareBalance,
  getVault,
  getVaultState,
  getVaults,
  isKnownVaultAddress,
  listEvents,
  normalizeAmount,
  previewDeposit,
  previewRedeem,
  recordEvent,
  setSupabase,
  upsertPosition,
  withdraw,
};
