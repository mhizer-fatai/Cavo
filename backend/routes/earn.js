const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { requireCavoSession, requireMatchingUserKey, ownsWalletAddress } = require("../services/sessions");
const { idempotencyGuard } = require("../middleware/idempotency");
const { schemas, validateBody } = require("../middleware/validate");
const { consumeApproval } = require("../services/pins");
const { getWalletForUser } = require("../services/swaps");
const earnService = require("../services/earn");

async function requireOwnWallet(userKey, walletAddress, walletId) {
  const wallet = await getWalletForUser(userKey);
  if (!wallet || wallet.circle_wallet_id !== walletId || wallet.wallet_address !== walletAddress) {
    throw Object.assign(new Error("Wallet does not belong to this Cavo account"), { status: 403 });
  }
  return wallet;
}

router.get("/vaults", async (req, res) => {
  try {
    const walletAddress = String(req.query.walletAddress || "").toLowerCase().trim() || undefined;
    const vaults = await earnService.getVaults(walletAddress);
    // Per-wallet balances are financial data: only expose them to the owner.
    if (walletAddress) {
      const owns = await ownsWalletAddress(req.authUserKey, walletAddress).catch(() => false);
      if (!owns) {
        return res.json(vaults.map(({ shareBalance, maxDeposit, maxRedeem, ...pub }) => pub));
      }
    }
    return res.json(vaults);
  } catch (err) {
    console.error("Earn vaults error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to fetch earn vaults" });
  }
});

router.get("/positions", requireCavoSession, requireMatchingUserKey, async (req, res) => {
  try {
    const userKey = req.authUserKey;
    const positions = await earnService.getPositions(userKey);
    const enriched = await Promise.all(
      positions.map(async position => {
        try {
          const state = await earnService.getVaultState(position.vault);
          const shares = Number(position.shares) || 0;
          const currentValue = shares * state.sharePrice;
          return {
            ...position,
            sharePrice: state.sharePrice,
            currentValue,
            earnings: currentValue - (Number(position.principal) || 0),
          };
        } catch {
          return position;
        }
      }),
    );
    return res.json(enriched);
  } catch (err) {
    console.error("Earn positions error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to fetch earn positions" });
  }
});

router.get("/history", requireCavoSession, requireMatchingUserKey, async (req, res) => {
  try {
    const userKey = req.authUserKey;
    const events = await earnService.listEvents(userKey);
    return res.json(events);
  } catch (err) {
    console.error("Earn history error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to fetch earn history" });
  }
});

router.post("/deposit", requireCavoSession, requireMatchingUserKey, validateBody(schemas.earnDeposit), idempotencyGuard, async (req, res) => {
  const userKey = req.authUserKey;
  const walletAddress = String(req.body.walletAddress || "").toLowerCase().trim();
  const walletId = String(req.body.walletId || "").trim();
  const token = String(req.body.token || "").toUpperCase().trim();
  const amount = String(req.body.amountIn || req.body.amount || "").trim();
  const approvalId = String(req.body.approvalId || "").trim();

  try {
    if (!walletAddress || !walletId || !token || !amount || !approvalId) {
      return res.status(400).json({ error: "walletAddress, walletId, token, amount, and approvalId are required" });
    }
    const entry = earnService.getVault(token);
    await requireOwnWallet(userKey, walletAddress, walletId);

    await consumeApproval({
      approvalId,
      userKey,
      walletAddress,
      walletId,
      destinationAddress: entry.vault,
      destinationChain: earnService.SOURCE_CHAIN,
      amount,
      token,
    });

    const result = await earnService.deposit({ walletId, walletAddress, token, amount });

    await earnService.upsertPosition({
      userKey,
      walletAddress,
      token,
      vault: entry.vault,
      sharesDelta: result.shares,
      principalDelta: result.amount,
    });
    await earnService.recordEvent({
      id: crypto.randomUUID(),
      user_key: userKey,
      wallet_address: walletAddress,
      token,
      vault: entry.vault.toLowerCase(),
      kind: "deposit",
      amount: result.amount,
      shares: result.shares,
      tx_hash: result.depositHash,
    });

    return res.json({
      status: "completed",
      token,
      amount: result.amount,
      shares: result.shares,
      approveHash: result.approveHash,
      txHash: result.depositHash,
    });
  } catch (err) {
    console.error("Earn deposit error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to deposit into earn vault" });
  }
});

router.post("/withdraw", requireCavoSession, requireMatchingUserKey, validateBody(schemas.earnWithdraw), idempotencyGuard, async (req, res) => {
  const userKey = req.authUserKey;
  const walletAddress = String(req.body.walletAddress || "").toLowerCase().trim();
  const walletId = String(req.body.walletId || "").trim();
  const token = String(req.body.token || "").toUpperCase().trim();
  const shares = String(req.body.shares || "").trim();
  const approvalId = String(req.body.approvalId || "").trim();
  const destinationChain = String(req.body.destinationChain || "Arc_Testnet").trim();
  const destinationAddress = String(req.body.destinationAddress || walletAddress).toLowerCase().trim();

  try {
    if (!walletAddress || !walletId || !token || !shares || !approvalId) {
      return res.status(400).json({ error: "walletAddress, walletId, token, shares, and approvalId are required" });
    }
    if (destinationChain !== "Arc_Testnet") {
      // Earn withdrawals always settle to the dashboard (Arc) balance;
      // the separate Withdraw feature is the CCTP path.
      throw Object.assign(new Error("Earn withdrawals always settle to your Arc balance. Use Withdraw to move funds cross-chain."), { status: 400 });
    }
    const entry = earnService.getVault(token);
    await requireOwnWallet(userKey, walletAddress, walletId);

    await consumeApproval({
      approvalId,
      userKey,
      walletAddress,
      walletId,
      destinationAddress: entry.vault,
      destinationChain: earnService.SOURCE_CHAIN,
      // Approval covers the share burn; amount echoes shares for binding.
      amount: shares,
      token,
    });

    const result = await earnService.withdraw({
      walletId,
      walletAddress,
      token,
      shares,
      destinationChain,
      destinationAddress,
    });

    // Reduce principal pro-rata so remaining earnings stay accurate.
    const positions = await earnService.getPositions(userKey);
    const current = positions.find(row => String(row.token).toUpperCase() === token);
    const sharesBefore = Number(current?.shares || result.shares);
    const principalBefore = Number(current?.principal || 0);
    const principalDelta = sharesBefore > 0 ? -(principalBefore * (result.shares / sharesBefore)) : 0;

    await earnService.upsertPosition({
      userKey,
      walletAddress,
      token,
      vault: entry.vault,
      sharesDelta: -result.shares,
      principalDelta,
    });
    await earnService.recordEvent({
      id: crypto.randomUUID(),
      user_key: userKey,
      wallet_address: walletAddress,
      token,
      vault: entry.vault.toLowerCase(),
      kind: "withdraw",
      amount: result.assets,
      shares: result.shares,
      tx_hash: result.redeemHash,
      bridge_tx_hash: result.bridgeHash,
      destination_chain: result.destinationChain,
      destination_address: result.destinationAddress,
    });

    return res.json({
      status: result.bridgeHash || result.destinationChain === "Arc_Testnet" ? "completed" : "bridging",
      token,
      shares: result.shares,
      amount: result.assets,
      txHash: result.redeemHash,
      bridgeTxHash: result.bridgeHash,
      bridgeState: result.bridgeState,
      destinationChain: result.destinationChain,
      destinationAddress: result.destinationAddress,
    });
  } catch (err) {
    console.error("Earn withdraw error:", err.message || err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to withdraw from earn vault" });
  }
});

module.exports = router;
