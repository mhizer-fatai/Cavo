const express = require("express");
const { schemas, validateQuery } = require("../middleware/validate");

const router = express.Router();
const ARCSCAN_API_BASE = "https://testnet.arcscan.app/api";

// Public Arc Testnet JSON-RPC endpoints (chain ID 5042002). Used as a fallback
// when the Arcscan API is rate-limited (HTTP 429) so balances keep working.
const ARC_RPC_URLS = [
  process.env.ARC_RPC_URL,
  "https://rpc.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
  "https://arc-testnet.drpc.org",
].filter(Boolean);

async function rpcRequest(method, params, timeoutMs = 8000) {
  let lastError;
  for (const baseUrl of ARC_RPC_URLS) {
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
  throw lastError || new Error("All Arc RPC endpoints failed");
}

function erc20BalanceOfData(walletAddress) {
  return `0x70a08231${String(walletAddress).toLowerCase().slice(2).padStart(64, "0")}`;
}

async function rpcTokenBalance(contractAddress, walletAddress) {
  const result = await rpcRequest("eth_call", [
    { to: contractAddress, data: erc20BalanceOfData(walletAddress) },
    "latest",
  ]);
  return BigInt(result || "0x0").toString(10);
}

async function rpcNativeBalance(walletAddress) {
  const result = await rpcRequest("eth_getBalance", [walletAddress, "latest"]);
  return BigInt(result || "0x0").toString(10);
}

// ─── RPC Transfer-log fallback (used when Arcscan tokentx is rate-limited) ───

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const LOG_SCAN_CHUNK = 4000;
const LOG_SCAN_LOOKBACK = 120000;
const MAX_STORED_TRANSFERS = 500;
const LOG_SCAN_BATCH = 12;

// key `${contract}|${wallet}` -> { transfers, checkpoint, ts }
// Persisted to disk so backend restarts don't trigger a full rescan;
// every later sync only fetches blocks since the checkpoint (seconds of work).
const path = require("path");
const fs = require("fs");
const TRANSFER_CACHE_FILE = path.join(__dirname, "..", ".transfer-scan-cache.json");

// key `${contract}|${wallet}` -> { transfers, checkpoint, ts }
const transferFallbackCache = new Map();
const transferScanInFlight = new Map();
const blockTimeCache = new Map();
const tokenMetaCache = new Map();

try {
  const raw = fs.readFileSync(TRANSFER_CACHE_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      if (value && Array.isArray(value.transfers) && Number.isFinite(value.checkpoint)) {
        transferFallbackCache.set(key, value);
      }
    }
  }
} catch {
  // No cache yet; the first scan will create it.
}

function persistTransferCache() {
  try {
    const entries = [...transferFallbackCache.entries()].slice(-20);
    fs.writeFileSync(TRANSFER_CACHE_FILE, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Disk persistence is best-effort; memory cache still works.
  }
}

function decodeAbiString(hex) {
  try {
    const buf = Buffer.from(String(hex || "").slice(2), "hex");
    if (buf.length < 64) return null;
    const len = Number(BigInt(`0x${buf.slice(32, 64).toString("hex")}`));
    if (!Number.isFinite(len) || len <= 0 || 64 + len > buf.length) return null;
    return buf.slice(64, 64 + len).toString("utf8").replace(/\0+$/, "") || null;
  } catch {
    return null;
  }
}

const KNOWN_TOKENS = {
  "0x3600000000000000000000000000000000000000": { name: "USD Coin", symbol: "USDC", decimals: 6 },
  "0x89b50855aa3be2f677cd6303cec089b5f319d72a": { name: "Euro Coin", symbol: "EURC", decimals: 6 },
};

async function getTokenMeta(contractAddress) {
  const key = String(contractAddress).toLowerCase();
  if (tokenMetaCache.has(key)) return tokenMetaCache.get(key);
  if (KNOWN_TOKENS[key]) {
    tokenMetaCache.set(key, KNOWN_TOKENS[key]);
    return KNOWN_TOKENS[key];
  }
  const meta = { name: "Unknown Token", symbol: "UNKNOWN", decimals: 18 };
  try {
    const [decHex, symHex, nameHex] = await Promise.all([
      rpcRequest("eth_call", [{ to: contractAddress, data: "0x313ce567" }, "latest"]).catch(() => null),
      rpcRequest("eth_call", [{ to: contractAddress, data: "0x95d89b41" }, "latest"]).catch(() => null),
      rpcRequest("eth_call", [{ to: contractAddress, data: "0x06fdde03" }, "latest"]).catch(() => null),
    ]);
    if (decHex) meta.decimals = Number(BigInt(decHex));
    const sym = symHex ? decodeAbiString(symHex) : null;
    if (sym) meta.symbol = sym;
    const name = nameHex ? decodeAbiString(nameHex) : null;
    if (name) meta.name = name;
  } catch {
    // Keep defaults; mapping still works.
  }
  tokenMetaCache.set(key, meta);
  return meta;
}

async function getBlockTimestamp(blockNumberHex) {
  if (blockTimeCache.has(blockNumberHex)) return blockTimeCache.get(blockNumberHex);
  const block = await rpcRequest("eth_getBlockByNumber", [blockNumberHex, false], 10000);
  const ts = block && block.timestamp ? BigInt(block.timestamp).toString(10) : "0";
  if (blockTimeCache.size > 5000) blockTimeCache.clear();
  blockTimeCache.set(blockNumberHex, ts);
  return ts;
}

async function scanTransferLogs(contractAddress, walletAddress) {
  const wallet = String(walletAddress).toLowerCase();
  const paddedWallet = `0x${wallet.slice(2).padStart(64, "0")}`;
  const cacheKey = `${String(contractAddress).toLowerCase()}|${wallet}`;

  if (transferScanInFlight.has(cacheKey)) {
    return transferScanInFlight.get(cacheKey);
  }

  const job = (async () => {
    const latest = parseInt(await rpcRequest("eth_blockNumber", [], 10000), 16);
    if (!Number.isFinite(latest)) throw new Error("Failed to fetch latest block");

    const state = transferFallbackCache.get(cacheKey);
    let fromBlock = Math.max(0, latest - LOG_SCAN_LOOKBACK);
    let acc = [];
    if (state && Number.isFinite(state.checkpoint) && state.checkpoint <= latest) {
      fromBlock = state.checkpoint + 1;
      acc = Array.isArray(state.transfers) ? state.transfers : [];
    }
    if (fromBlock > latest) {
      return acc;
    }

    const chunks = [];
    for (let start = fromBlock; start <= latest; start += LOG_SCAN_CHUNK + 1) {
      chunks.push({
        from: `0x${start.toString(16)}`,
        to: `0x${Math.min(start + LOG_SCAN_CHUNK, latest).toString(16)}`,
      });
    }

    const logs = [];
    for (let i = 0; i < chunks.length; i += LOG_SCAN_BATCH) {
      const batch = chunks.slice(i, i + LOG_SCAN_BATCH);
      const results = await Promise.all(
        batch.flatMap(chunk => [
          rpcRequest(
            "eth_getLogs",
            [{ address: contractAddress, topics: [TRANSFER_TOPIC, paddedWallet, null], fromBlock: chunk.from, toBlock: chunk.to }],
            15000,
          ).catch(() => []),
          rpcRequest(
            "eth_getLogs",
            [{ address: contractAddress, topics: [TRANSFER_TOPIC, null, paddedWallet], fromBlock: chunk.from, toBlock: chunk.to }],
            15000,
          ).catch(() => []),
        ]),
      );
      for (const result of results) {
        if (Array.isArray(result)) logs.push(...result);
      }
    }

    const seen = new Set(acc.map(item => `${item.hash}-${item.logIndex}`));
    const fresh = [];
    for (const log of logs) {
      if (!log || !log.transactionHash || !Array.isArray(log.topics) || log.topics.length < 3) continue;
      const key = `${log.transactionHash}-${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(log);
    }

    const meta = await getTokenMeta(contractAddress);
    const blockNumbers = [...new Set(fresh.map(log => log.blockNumber))];
    const timestamps = {};
    await Promise.all(
      blockNumbers.map(async blockNumber => {
        try {
          timestamps[blockNumber] = await getBlockTimestamp(blockNumber);
        } catch {
          timestamps[blockNumber] = "0";
        }
      }),
    );

    const mapped = fresh.map(log => ({
      blockNumber: String(parseInt(log.blockNumber, 16)),
      timeStamp: timestamps[log.blockNumber] || "0",
      hash: log.transactionHash,
      nonce: "0",
      blockHash: log.blockHash,
      from: `0x${log.topics[1].slice(26)}`.toLowerCase(),
      to: `0x${log.topics[2].slice(26)}`.toLowerCase(),
      contractAddress: String(contractAddress).toLowerCase(),
      value: BigInt(log.data || "0x0").toString(10),
      tokenName: meta.name,
      tokenSymbol: meta.symbol,
      tokenDecimal: String(meta.decimals),
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
    }));

    const all = [...mapped, ...acc]
      .sort((a, b) => Number(b.timeStamp) - Number(a.timeStamp) || String(b.hash).localeCompare(String(a.hash)))
      .slice(0, MAX_STORED_TRANSFERS);
    transferFallbackCache.set(cacheKey, { transfers: all, checkpoint: latest, ts: Date.now() });
    persistTransferCache();
    return all;
  })();

  transferScanInFlight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    transferScanInFlight.delete(cacheKey);
  }
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

async function fetchArcscan(params) {
  const url = `${ARCSCAN_API_BASE}?${new URLSearchParams(params).toString()}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    const error = new Error(payload?.message || `Arcscan API ${response.status}`);
    error.status = response.status;
    error.data = payload;
    throw error;
  }
  return payload;
}

router.get("/token-balance", validateQuery(schemas.arcscanBalance), async (req, res) => {
  const { address, contractaddress } = req.query;
  try {
    if (!isAddress(address) || !isAddress(contractaddress)) {
      return res.status(400).json({ error: "Valid address and contractaddress are required" });
    }

    const payload = await fetchArcscan({
      module: "account",
      action: "tokenbalance",
      address: String(address),
      contractaddress: String(contractaddress),
    });
    return res.json(payload);
  } catch (err) {
    console.error("Arcscan token balance proxy error:", err.data || err.message || err);
    try {
      const result = await rpcTokenBalance(String(contractaddress), String(address));
      return res.json({ status: "1", message: "OK (rpc fallback)", result });
    } catch (fallbackErr) {
      console.error("Arc RPC token balance fallback error:", fallbackErr.message || fallbackErr);
      return res.status(err.status || 502).json({
        error: "Failed to fetch token balance",
        details: {
          arcscan: err.data || err.message,
          rpcFallback: fallbackErr.message || String(fallbackErr),
        },
      });
    }
  }
});

router.get("/native-balance", validateQuery(schemas.arcscanNative), async (req, res) => {
  const { address } = req.query;
  try {
    if (!isAddress(address)) {
      return res.status(400).json({ error: "Valid address is required" });
    }

    const payload = await fetchArcscan({
      module: "account",
      action: "balance",
      address: String(address),
    });
    return res.json(payload);
  } catch (err) {
    console.error("Arcscan native balance proxy error:", err.data || err.message || err);
    try {
      const result = await rpcNativeBalance(String(address));
      return res.json({ status: "1", message: "OK (rpc fallback)", result });
    } catch (fallbackErr) {
      console.error("Arc RPC native balance fallback error:", fallbackErr.message || fallbackErr);
      return res.status(err.status || 502).json({ error: "Failed to fetch native balance" });
    }
  }
});

router.get("/token-transfers", validateQuery(schemas.arcscanTransfers), async (req, res) => {
  const { address, contractaddress } = req.query;
  try {
    if (!isAddress(address) || !isAddress(contractaddress)) {
      return res.status(400).json({ error: "Valid address and contractaddress are required" });
    }

    const payload = await fetchArcscan({
      module: "account",
      action: "tokentx",
      address: String(address),
      contractaddress: String(contractaddress),
    });
    return res.json(payload);
  } catch (err) {
    console.error("Arcscan token transfers proxy error:", err.data || err.message || err);
    try {
      const result = await scanTransferLogs(String(contractaddress), String(address));
      return res.json({ status: "1", message: "OK (rpc logs fallback)", result });
    } catch (fallbackErr) {
      console.error("Arc RPC transfer log fallback error:", fallbackErr.message || fallbackErr);
      return res.status(err.status || 502).json({
        error: "Failed to fetch token transfers",
        details: {
          arcscan: err.data || err.message,
          rpcFallback: fallbackErr.message || String(fallbackErr),
        },
      });
    }
  }
});

module.exports = router;
