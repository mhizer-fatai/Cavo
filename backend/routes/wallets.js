const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const {
  createWalletForUser,
  findTransactionHash,
  findTransactionId,
  getTransactionStatus,
  getWalletBalance,
  getWalletTokenId,
  transferTokens,
  waitForTransactionHash,
} = require('../services/wallets');
const { consumeApproval } = require('../services/pins');
const { requireMatchingUserKey, requireCavoSession } = require('../services/sessions');
const { idempotencyGuard } = require('../middleware/idempotency');
const { schemas, validateBody } = require('../middleware/validate');
const {
  SOURCE_CHAIN,
  SUPPORTED_DESTINATION_CHAINS,
  bridgeUsdcFromArc,
  isValidAddressForChain,
  normalizeAccountAddress,
  normalizeDestinationChain,
} = require('../services/arc');

// Supabase client (reuse from main app)
let supabase;
function setSupabase(client) { supabase = client; }

const pendingWalletCreates = new Map();
const trackedTransactions = new Map();
const TRACKING_TTL_MS = 24 * 60 * 60 * 1000;
const TRACKING_MAX_RECORDS = 5000;
const ARC_USDC_TOKEN_ADDRESS = '0x3600000000000000000000000000000000000000';
const ARC_EURC_TOKEN_ADDRESS = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

function createTrackingRecord(payload) {
  // Bounded cache: evict expired records, then oldest-first past the cap.
  const nowMs = Date.now();
  for (const [id, record] of trackedTransactions) {
    if (nowMs - new Date(record.createdAt).getTime() > TRACKING_TTL_MS) {
      trackedTransactions.delete(id);
    }
  }
  while (trackedTransactions.size >= TRACKING_MAX_RECORDS) {
    trackedTransactions.delete(trackedTransactions.keys().next().value);
  }
  const trackingId = crypto.randomUUID();
  const now = new Date().toISOString();
  const transaction = payload.transaction || null;
  const txHash = payload.txHash || findTransactionHash(transaction);
  const record = {
    trackingId,
    userKey: payload.userKey,
    walletAddress: payload.walletAddress,
    walletId: payload.walletId,
    destinationAddress: payload.destinationAddress,
    destinationChain: payload.destinationChain,
    amount: payload.amount,
    token: payload.token || 'USDC',
    status: txHash ? 'complete' : (payload.status || 'pending'),
    txHash,
    circleTransactionId: payload.circleTransactionId || findTransactionId(transaction),
    transaction,
    createdAt: now,
    updatedAt: now,
  };
  trackedTransactions.set(trackingId, record);
  return record;
}

async function refreshTrackingRecord(record) {
  if (record.txHash) {
    record.status = 'complete';
    record.updatedAt = new Date().toISOString();
    return record;
  }

  const transactionId = record.circleTransactionId || findTransactionId(record.transaction);
  if (!transactionId) {
    record.updatedAt = new Date().toISOString();
    return record;
  }

  try {
    const status = await getTransactionStatus(transactionId);
    const txHash = findTransactionHash(status);
    record.transaction = status;
    record.circleTransactionId = transactionId;
    record.txHash = txHash || record.txHash;
    record.status = txHash
      ? 'complete'
      : (status?.transaction?.state || status?.state || record.status || 'pending');
  } catch (error) {
    record.lastError = error.message || 'Unable to refresh transaction status';
  }
  record.updatedAt = new Date().toISOString();
  return record;
}

function serializeTrackingRecord(record) {
  return {
    trackingId: record.trackingId,
    status: record.status,
    txHash: record.txHash || null,
    destinationChain: record.destinationChain,
    destinationAddress: record.destinationAddress,
    amount: record.amount,
    token: record.token,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    transaction: record.transaction,
    error: record.lastError,
  };
}

async function getExistingWallet(userAddress) {
  const { data } = await supabase
    .from('user_wallets')
    .select('*')
    .eq('user_address', userAddress)
    .eq('wallet_type', 'developer_controlled')
    .maybeSingle();

  return data;
}

async function createAndStoreWallet(userAddress) {
  const existing = await getExistingWallet(userAddress);
  if (existing) return { wallet: existing, created: false };

  const wallet = await createWalletForUser(userAddress);

  const record = {
    user_address: userAddress,
    wallet_address: wallet.address.toLowerCase(),
    circle_wallet_id: wallet.walletId,
    circle_wallet_set_id: wallet.walletSetId,
    wallet_type: 'developer_controlled',
  };

  const { data, error } = await supabase
    .from('user_wallets')
    .upsert(record, { onConflict: 'user_address' })
    .select()
    .single();

  if (error) {
    const afterRace = await getExistingWallet(userAddress);
    if (afterRace) return { wallet: afterRace, created: false };
    throw error;
  }

  return { wallet: data, created: true };
}

/**
 * POST /api/wallets/create
 * Creates a Circle Dev-Controlled wallet for the user on Arc Testnet.
 * If the user already has one, returns the existing wallet.
 */
router.post('/create', requireCavoSession, requireMatchingUserKey, async (req, res) => {
  try {
    const userAddress = req.authUserKey;
    if (!userAddress) return res.status(401).json({ error: 'Cavo session is missing identity' });
    if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });
    const normalizedAddress = userAddress;

    // Check if user already has a wallet
    const existing = await getExistingWallet(normalizedAddress);

    if (existing) {
      return res.json({
        walletAddress: existing.wallet_address,
        walletId: existing.circle_wallet_id,
        walletSetId: existing.circle_wallet_set_id,
        walletType: existing.wallet_type || 'developer_controlled',
        ownerUserKey: existing.user_address,
        exists: true,
      });
    }

    let createPromise = pendingWalletCreates.get(normalizedAddress);
    if (!createPromise) {
      createPromise = createAndStoreWallet(normalizedAddress);
      pendingWalletCreates.set(normalizedAddress, createPromise);
    }

    const { wallet, created } = await createPromise;
    return res.json({
      walletAddress: wallet.wallet_address,
      walletId: wallet.circle_wallet_id,
      walletSetId: wallet.circle_wallet_set_id,
      walletType: wallet.wallet_type || 'developer_controlled',
      ownerUserKey: wallet.user_address,
      exists: !created,
    });
  } catch (err) {
    const details = err?.response?.data || err?.data || err?.message || String(err);
    console.error('Wallet creation error:', details);
    return res.status(500).json({
      error: 'Failed to create Circle wallet',
      details: process.env.NODE_ENV !== 'production' ? details : undefined,
    });
  } finally {
    const cleanupKey = req.authUserKey;
    if (cleanupKey) {
      pendingWalletCreates.delete(cleanupKey);
    }
  }
});

/**
 * GET /api/wallets/me?address=0x...
 * Returns the user's Circle wallet info.
 */
router.get('/me', requireCavoSession, requireMatchingUserKey, async (req, res) => {
  try {
    const address = req.authUserKey;
    if (!address) return res.status(401).json({ error: 'Cavo session is missing identity' });
    if (!supabase) return res.status(500).json({ error: 'Supabase client not initialized' });

    const wallet = await getExistingWallet(address.toLowerCase());

    if (!wallet) {
      return res.json({ exists: false });
    }

    return res.json({
      exists: true,
      walletAddress: wallet.wallet_address,
      walletId: wallet.circle_wallet_id,
      walletSetId: wallet.circle_wallet_set_id,
      walletType: wallet.wallet_type || 'developer_controlled',
      ownerUserKey: wallet.user_address,
      balance: [],
    });
  } catch (err) {
    const details = err?.response?.data || err?.data || err?.message || String(err);
    console.error('Wallet lookup error:', details);
    return res.status(500).json({
      error: 'Failed to fetch Circle wallet',
      details: process.env.NODE_ENV !== 'production' ? details : undefined,
    });
  }
});

router.post('/send', requireCavoSession, requireMatchingUserKey, validateBody(schemas.walletSend), idempotencyGuard, async (req, res) => {
  try {
    const userKey = req.authUserKey;
    const walletAddress = String(req.body.walletAddress || '').toLowerCase().trim();
    const walletId = String(req.body.walletId || '').trim();
    const destinationAddress = String(req.body.destinationAddress || '').trim();
    const destinationChain = normalizeDestinationChain(req.body.destinationChain || SOURCE_CHAIN);
    const amount = String(req.body.amount || '').trim();
    const approvalId = String(req.body.approvalId || '').trim();
    const token = String(req.body.token || 'USDC').toUpperCase();

    if (!walletAddress || !walletId || !destinationAddress || !amount || !approvalId) {
      return res.status(400).json({ error: 'walletAddress, walletId, destinationAddress, amount, and approvalId are required' });
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(destinationAddress)) {
      return res.status(400).json({ error: 'Valid destination address is required' });
    }
    if (!['USDC', 'EURC'].includes(token)) {
      return res.status(400).json({ error: 'token must be USDC or EURC' });
    }
    if (token === 'EURC' && destinationChain !== SOURCE_CHAIN) {
      return res.status(400).json({ error: 'EURC sends are only supported on Arc Testnet' });
    }

    const wallet = await getExistingWallet(userKey);
    if (!wallet || wallet.circle_wallet_id !== walletId || wallet.wallet_address !== walletAddress) {
      return res.status(403).json({ error: 'Wallet does not belong to this Cavo account' });
    }

    await consumeApproval({
      approvalId,
      userKey,
      walletAddress,
      walletId,
      destinationAddress,
      destinationChain,
      amount,
      token,
    });

    const tokenId = await getWalletTokenId(walletId, {
      symbol: token,
      tokenAddress: token === 'EURC'
        ? (process.env.ARC_EURC_ADDRESS || ARC_EURC_TOKEN_ADDRESS)
        : (process.env.ARC_USDC_ADDRESS || ARC_USDC_TOKEN_ADDRESS),
    });
    const transaction = await transferTokens(walletId, destinationAddress, tokenId, amount);
    const txHash = await waitForTransactionHash(transaction);
    const tracking = createTrackingRecord({
      userKey,
      walletAddress,
      walletId,
      destinationAddress,
      destinationChain,
      amount,
      token,
      status: txHash ? 'complete' : 'pending',
      txHash,
      transaction,
    });

    if (!txHash) {
      return res.status(202).json({
        trackingId: tracking.trackingId,
        status: 'pending',
        transaction,
        error: 'Transfer submitted but transaction hash is not available yet',
      });
    }

    return res.json({ trackingId: tracking.trackingId, status: 'complete', txHash, transaction });
  } catch (err) {
    const details = err?.response?.data || err?.data || err?.message || String(err);
    console.error('Dev-controlled send error:', details);
    return res.status(err.status || 500).json({
      error: err.message || 'Failed to send payment',
      details: process.env.NODE_ENV !== 'production' ? details : undefined,
    });
  }
});

router.get('/destination-chains', (_req, res) => {
  return res.json(Object.values(SUPPORTED_DESTINATION_CHAINS));
});

router.get('/transactions/:trackingId', requireCavoSession, async (req, res) => {
  try {
    const record = trackedTransactions.get(req.params.trackingId);
    if (!record) return res.status(404).json({ error: 'Transaction tracker not found' });
    if (record.userKey !== req.authUserKey) {
      return res.status(403).json({ error: 'Transaction tracker does not belong to this Cavo session' });
    }

    const refreshed = await refreshTrackingRecord(record);
    return res.json(serializeTrackingRecord(refreshed));
  } catch (err) {
    const details = err?.response?.data || err?.data || err?.message || String(err);
    console.error('Wallet transaction tracking error:', details);
    return res.status(500).json({
      error: 'Failed to refresh transaction status',
      details: process.env.NODE_ENV !== 'production' ? details : undefined,
    });
  }
});

router.post('/bridge', requireCavoSession, requireMatchingUserKey, validateBody(schemas.walletBridge), idempotencyGuard, async (req, res) => {
  try {
    const userKey = req.authUserKey;
    const walletAddress = String(req.body.walletAddress || '').toLowerCase().trim();
    const walletId = String(req.body.walletId || '').trim();
    const destinationChain = normalizeDestinationChain(req.body.destinationChain);
    const destinationAddress = normalizeAccountAddress(destinationChain, req.body.destinationAddress);
    const amount = String(req.body.amount || '').trim();
    const approvalId = String(req.body.approvalId || '').trim();

    if (!walletAddress || !walletId || !destinationAddress || !destinationChain || !amount || !approvalId) {
      return res.status(400).json({ error: 'walletAddress, walletId, destinationAddress, destinationChain, amount, and approvalId are required' });
    }
    if (!isValidAddressForChain(destinationChain, destinationAddress)) {
      return res.status(400).json({ error: 'Destination address does not match the destination chain format' });
    }
    if (destinationChain === SOURCE_CHAIN) {
      return res.status(400).json({ error: 'Use /wallets/send for Arc Testnet transfers' });
    }

    const wallet = await getExistingWallet(userKey);
    if (!wallet || wallet.circle_wallet_id !== walletId || wallet.wallet_address !== walletAddress) {
      return res.status(403).json({ error: 'Wallet does not belong to this Cavo account' });
    }

    await consumeApproval({
      approvalId,
      userKey,
      walletAddress,
      walletId,
      destinationAddress,
      destinationChain,
      amount,
      token: 'USDC',
    });

    const bridge = await bridgeUsdcFromArc({
      fromAddress: walletAddress,
      toAddress: destinationAddress,
      destinationChain,
      amount,
    });
    const tracking = createTrackingRecord({
      userKey,
      walletAddress,
      walletId,
      destinationAddress,
      destinationChain,
      amount,
      token: 'USDC',
      status: bridge.txHash ? 'complete' : (bridge.state || 'pending'),
      txHash: bridge.txHash,
      transaction: bridge.result,
    });

    if (!bridge.txHash) {
      return res.status(202).json({
        trackingId: tracking.trackingId,
        status: bridge.state || 'pending',
        destinationChain,
        transaction: bridge.result,
        error: 'Bridge submitted but transaction hash is not available yet',
      });
    }

    return res.json({
      trackingId: tracking.trackingId,
      status: bridge.state === 'success' ? 'complete' : bridge.state,
      destinationChain,
      txHash: bridge.txHash,
      transaction: bridge.result,
    });
  } catch (err) {
    const details = err?.response?.data || err?.data || err?.message || String(err);
    console.error('Arc bridge send error:', details);
    return res.status(err.status || 500).json({
      error: err.message || 'Failed to bridge payment',
      details: process.env.NODE_ENV !== 'production' ? details : undefined,
    });
  }
});

module.exports = { router, setSupabase };
