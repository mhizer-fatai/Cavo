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

  return { approval: data.approval, swap: data.swap };
}

async function executeSwap() {
  throw Object.assign(
    new Error("Tower swap execution is disabled until the Arc mainnet migration. Use the Circle provider."),
    { status: 501 },
  );
}

module.exports = { getQuote, buildUnsignedSwapTransaction, executeSwap };
