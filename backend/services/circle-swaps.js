const {
  SOURCE_CHAIN,
  getCircleWalletsKit,
  findResultTransactionHash,
  toJsonSafe,
} = require("./arc");

function getKitConfig() {
  const config = {};
  if (process.env.CIRCLE_KIT_KEY) config.kitKey = process.env.CIRCLE_KIT_KEY;
  return Object.keys(config).length > 0 ? config : undefined;
}

// Server-side slippage floor (basis points). Execution aborts unless a fresh
// quote still satisfies both the user's tolerance and this safety floor,
// so MEV sandwiches cannot fill the user below it.
const SERVER_SLIPPAGE_BPS = Number(process.env.SWAP_SLIPPAGE_BPS || 50);

function toFloorAmount(amountStr) {
  const n = Number(amountStr);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error("Swap quote is unavailable right now"), { status: 502 });
  }
  return (n * (10000 - SERVER_SLIPPAGE_BPS)) / 10000;
}

function formatTokenAmount(n) {
  const text = Number(n).toFixed(6).replace(/\.?0+$/, "");
  return text === "" ? "0" : text;
}

function normalizeQuote(estimate, { tokenIn, tokenOut, amountIn }) {
  const estimatedOutput = estimate?.estimatedOutput?.amount;
  const minOut = estimate?.stopLimit?.amount;
  if (!estimatedOutput || !minOut) {
    throw Object.assign(new Error("Swap liquidity is unavailable for this pair right now"), { status: 503 });
  }
  return {
    provider: "circle",
    tokenIn,
    tokenOut,
    amountIn,
    estimatedOutput,
    minOut,
    feeBps: null,
    priceImpact: null,
    expiresAt: null,
  };
}

async function getQuote({ tokenIn, tokenOut, amountIn, walletAddress }) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(walletAddress || ""))) {
    throw Object.assign(new Error("A valid wallet address is required for swap quotes"), { status: 400 });
  }
  const { adapter, kit } = getCircleWalletsKit();
  const estimate = await kit.estimateSwap({
    from: { adapter, chain: SOURCE_CHAIN, address: walletAddress },
    tokenIn,
    tokenOut,
    amountIn,
    config: getKitConfig(),
  });
  return normalizeQuote(toJsonSafe(estimate), { tokenIn, tokenOut, amountIn });
}

async function executeSwap({ walletAddress, tokenIn, tokenOut, amountIn, minOut }) {
  const { adapter, kit } = getCircleWalletsKit();
  // Fresh quote at execution time: abort unless the market still satisfies
  // the stricter of the user's quoted tolerance and the server safety floor.
  const fresh = await kit.estimateSwap({
    from: { adapter, chain: SOURCE_CHAIN, address: walletAddress },
    tokenIn,
    tokenOut,
    amountIn,
  });
  const freshOut = Number(fresh?.estimatedOutput?.amount);
  if (!Number.isFinite(freshOut) || freshOut <= 0) {
    throw Object.assign(new Error("Swap quote is unavailable right now"), { status: 502 });
  }
  const floor = toFloorAmount(fresh.estimatedOutput.amount);
  const clientFloor = minOut !== undefined && minOut !== null && minOut !== "" ? Number(minOut) : NaN;
  const effective = formatTokenAmount(Number.isFinite(clientFloor) && clientFloor > 0 ? Math.max(clientFloor, floor) : floor);
  const result = await kit.swap({
    from: { adapter, chain: SOURCE_CHAIN, address: walletAddress },
    tokenIn,
    tokenOut,
    amountIn,
    config: { ...getKitConfig(), stopLimit: effective },
  });

  const safeResult = toJsonSafe(result);
  const txHash = findResultTransactionHash(safeResult);
  const progress = safeResult?.progress?.status || safeResult?.state || "submitted";

  return {
    txHash: txHash || null,
    amountOut: safeResult?.amountOut || null,
    enforcedMinOut: effective,
    status: progress,
    raw: safeResult,
  };
}

module.exports = { getQuote, executeSwap };
