const TOWER_API_BASE = process.env.TOWER_API_BASE || "https://www.tower.exchange/api/public";
const TOKEN_DECIMALS = { USDC: 6, EURC: 6 };
const TOKEN_ADDRESSES = {
  USDC: process.env.ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
  EURC: process.env.ARC_EURC_ADDRESS || "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
};
const REQUEST_TIMEOUT_MS = 20_000;

function requireApiKey() {
  const apiKey = process.env.TOWER_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("TOWER_API_KEY is not configured"), { status: 500 });
  }
  return apiKey;
}

async function towerRequest(path, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${TOWER_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${requireApiKey()}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(new Error("Tower API request timed out"), { status: 504 });
    }
    throw Object.assign(new Error("Tower API is unreachable"), { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.error || `Tower API error (HTTP ${response.status})`;
    const status = response.status === 404 ? 404 : response.status === 429 ? 429 : 502;
    throw Object.assign(new Error(message), { status });
  }
  return payload.data;
}

function toAtomic(amount, token) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error("Valid swap amount is required"), { status: 400 });
  }
  return BigInt(Math.round(value * 10 ** TOKEN_DECIMALS[token])).toString();
}

function fromAtomic(value, token) {
  return (Number(value) / 10 ** TOKEN_DECIMALS[token]).toString();
}

async function getQuote({ tokenIn, tokenOut, amountIn }) {
  const data = await towerRequest("/swap/quote", {
    method: "POST",
    body: {
      inputToken: tokenIn,
      outputToken: tokenOut,
      inputAmount: toAtomic(amountIn, tokenIn),
      slippageTolerance: Number(process.env.TOWER_SLIPPAGE_BPS || 50),
    },
  });

  if (!data?.outputAmountRaw || !data?.minOutRaw) {
    throw Object.assign(new Error("No valid Tower swap route found"), { status: 404 });
  }

  return {
    provider: "tower",
    tokenIn,
    tokenOut,
    amountIn,
    estimatedOutput: fromAtomic(data.outputAmountRaw, tokenOut),
    minOut: fromAtomic(data.minOutRaw, tokenOut),
    feeBps: data.feeBps ?? null,
    priceImpact: data.priceImpact ?? null,
    expiresAt: data.expiresAt || null,
    raw: data,
  };
}

async function buildUnsignedSwapTransaction({ tokenIn, tokenOut, amountIn, userAddress }) {
  const quote = await towerRequest("/swap/quote", {
    method: "POST",
    body: {
      inputToken: TOKEN_ADDRESSES[tokenIn] || tokenIn,
      outputToken: TOKEN_ADDRESSES[tokenOut] || tokenOut,
      inputAmount: toAtomic(amountIn, tokenIn),
      slippageTolerance: Number(process.env.TOWER_SLIPPAGE_BPS || 50),
    },
  });

  const data = await towerRequest("/swap/build-tx", {
    method: "POST",
    body: { quote, userAddress },
  });

  return {
    approval: data.approval || null,
    swap: data.swap || null,
    minOut: quote.minOutRaw ? fromAtomic(quote.minOutRaw, tokenOut) : null,
    expectedOut: data.swap?.expectedUserOutput
      ? fromAtomic(String(data.swap.expectedUserOutput), tokenOut)
      : null,
  };
}

async function executeSwap({ walletId, walletAddress, tokenIn, tokenOut, amountIn, minOut }) {
  const { executeRawCalldata, waitForTransactionHash } = require("./wallets");
  if (!walletId) {
    throw Object.assign(new Error("Wallet ID is required for Tower swap execution"), { status: 400 });
  }
  // Fresh quote + unsigned txs (Tower re-quotes inside build-tx).
  const built = await buildUnsignedSwapTransaction({
    tokenIn,
    tokenOut,
    amountIn,
    userAddress: walletAddress,
  });
  if (!built.swap?.to || !built.swap?.data) {
    throw Object.assign(new Error("Tower did not return a swap transaction"), { status: 502 });
  }
  // Server-side slippage floor: abort if the fresh market moved beyond the
  // user's quoted tolerance (Tower enforces its own bound on-chain).
  const towerMinOut = built.minOut !== null ? Number(built.minOut) : NaN;
  const clientFloor = minOut !== undefined && minOut !== null && minOut !== "" ? Number(minOut) : NaN;
  if (Number.isFinite(clientFloor) && clientFloor > 0) {
    if (!Number.isFinite(towerMinOut) || towerMinOut < clientFloor) {
      throw Object.assign(new Error("Market moved beyond your quoted tolerance. Request a fresh quote."), { status: 409 });
    }
  }
  // 1. Approval leg (Tower returns it when the executor needs allowance).
  if (built.approval?.to && built.approval?.data) {
    const approvalTx = await executeRawCalldata(walletId, built.approval.to, built.approval.data);
    const approvalHash = await waitForTransactionHash(approvalTx);
    if (!approvalHash) {
      throw Object.assign(new Error("Swap approval was submitted but no transaction hash was returned. Check the explorer before retrying."), { status: 502 });
    }
  }
  // 2. Swap leg.
  const swapTx = await executeRawCalldata(walletId, built.swap.to, built.swap.data);
  const txHash = await waitForTransactionHash(swapTx);
  return {
    txHash: txHash || null,
    amountOut: built.expectedOut,
    enforcedMinOut: Number.isFinite(towerMinOut) ? String(towerMinOut) : null,
    status: txHash ? "submitted" : "pending",
  };
}

module.exports = { getQuote, buildUnsignedSwapTransaction, executeSwap };
