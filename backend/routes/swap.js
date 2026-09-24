const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { requireMatchingUserKey, requireCavoSession } = require("../services/sessions");
const { idempotencyGuard } = require("../middleware/idempotency");
const { schemas, validateBody } = require("../middleware/validate");
const { consumeApproval } = require("../services/pins");
const swapService = require("../services/swaps");

router.post("/quote", requireCavoSession, requireMatchingUserKey, validateBody(schemas.swapQuote), async (req, res) => {
  try {
    const quote = await swapService.getSwapQuote({
      tokenIn: req.body.tokenIn,
      tokenOut: req.body.tokenOut,
      amountIn: req.body.amountIn,
      walletAddress: String(req.body.walletAddress || "").toLowerCase().trim() || undefined,
    });
    return res.json(quote);
  } catch (err) {
    console.error("Swap quote error:", err.message || err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to fetch swap quote",
    });
  }
});

router.post("/execute", requireCavoSession, requireMatchingUserKey, validateBody(schemas.swapExecute), idempotencyGuard, async (req, res) => {
  const userKey = req.authUserKey;
  const walletAddress = String(req.body.walletAddress || "").toLowerCase().trim();
  const walletId = String(req.body.walletId || "").trim();
  const tokenIn = String(req.body.tokenIn || "").toUpperCase().trim();
  const tokenOut = String(req.body.tokenOut || "").toUpperCase().trim();
  const amountIn = String(req.body.amountIn || "").trim();
  const minOut = req.body.minOut ? String(req.body.minOut).trim() : null;
  const approvalId = String(req.body.approvalId || "").trim();

  try {
    if (!walletAddress || !walletId || !tokenIn || !tokenOut || !amountIn || !approvalId) {
      return res.status(400).json({ error: "walletAddress, walletId, tokenIn, tokenOut, amountIn, and approvalId are required" });
    }
    swapService.validateSwapPair(tokenIn, tokenOut);

    const wallet = await swapService.getWalletForUser(userKey);
    if (!wallet || wallet.circle_wallet_id !== walletId || wallet.wallet_address !== walletAddress) {
      return res.status(403).json({ error: "Wallet does not belong to this Cavo account" });
    }

    await consumeApproval({
      approvalId,
      userKey,
      walletAddress,
      walletId,
      destinationAddress: walletAddress,
      destinationChain: swapService.SOURCE_CHAIN,
      amount: amountIn,
      token: tokenIn,
      tokenOut,
    });

    const provider = swapService.getProviderName();
    const quote = {
      requested: { tokenIn, tokenOut, amountIn, minOut },
      provider,
    };

    const swapId = crypto.randomUUID();
    await swapService.createSwapRecord({
      id: swapId,
      user_key: userKey,
      wallet_address: walletAddress,
      token_in: tokenIn,
      token_out: tokenOut,
      amount_in: Number(amountIn),
      min_out: minOut ? Number(minOut) : null,
      provider,
      status: "pending",
      tx_hash: null,
      quote,
      created_at: new Date().toISOString(),
    });

    const result = await swapService.executeSwap({ provider, walletAddress, tokenIn, tokenOut, amountIn, minOut });

    await swapService.updateSwapRecord(swapId, {
      status: result.txHash ? "completed" : "pending",
      tx_hash: result.txHash,
      amount_out: result.amountOut ? Number(result.amountOut) : null,
      quote: { ...quote, enforcedMinOut: result.enforcedMinOut || null, result: result.raw },
    });

    return res.json({
      swapId,
      status: result.txHash ? "completed" : result.status,
      txHash: result.txHash,
      amountOut: result.amountOut,
      enforcedMinOut: result.enforcedMinOut || null,
    });
  } catch (err) {
    console.error("Swap execution error:", err.message || err);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to execute swap",
    });
  }
});

router.get("/history", requireCavoSession, requireMatchingUserKey, async (req, res) => {
  try {
    const userKey = req.authUserKey;
    const swaps = await swapService.listSwapsForUser(userKey);
    return res.json(swaps);
  } catch (err) {
    console.error("Swap history error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to fetch swap history" });
  }
});

module.exports = router;
