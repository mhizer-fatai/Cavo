const { initiateDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets');

let circleClient = null;

function getCircleClient() {
  if (circleClient) return circleClient;

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    console.warn('CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET not set; Circle wallets are disabled.');
    return null;
  }

  circleClient = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  console.log('🔐 Circle Dev-Controlled Wallets initialized.');
  return circleClient;
}

/**
 * Create a wallet set + wallet on ARC-TESTNET for a user.
 * Returns { walletId, walletSetId, address }
 */
async function createWalletForUser(userId) {
  const client = getCircleClient();
  if (!client) throw new Error('Circle client not initialized');

  // Create a wallet set for this user
  const walletSetRes = await client.createWalletSet({
    name: `Cavopay-${userId}`,
  });

  const walletSetId = walletSetRes.data?.walletSet?.id;
  if (!walletSetId) throw new Error('Failed to create wallet set');

  // Create a wallet on Arc Testnet
  const walletRes = await client.createWallets({
    walletSetId,
    blockchains: ['ARC-TESTNET'],
    count: 1,
    accountType: 'EOA',
  });

  const wallet = walletRes.data?.wallets?.[0];
  if (!wallet) throw new Error('Failed to create wallet');

  return {
    walletId: wallet.id,
    walletSetId,
    address: wallet.address,
    blockchain: wallet.blockchain,
  };
}

/**
 * Sign and send a contract call from a user's Circle wallet.
 */
async function executeContractCall(walletId, contractAddress, abiFunctionSignature, args) {
  const client = getCircleClient();
  if (!client) throw new Error('Circle client not initialized');

  const res = await client.createContractExecutionTransaction({
    walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters: args,
    fee: {
      type: 'level',
      config: { feeLevel: 'MEDIUM' },
    },
  });

  return res.data;
}

/**
 * Transfer tokens from a Circle wallet to an address.
 */
async function transferTokens(walletId, destinationAddress, token, amount) {
  const client = getCircleClient();
  if (!client) throw new Error('Circle client not initialized');

  const tokenField = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
    ? { tokenId: token }
    : { tokenAddress: token };

  const res = await client.createTransaction({
    walletId,
    ...tokenField,
    destinationAddress,
    amount: [amount],
    fee: {
      type: 'level',
      config: { feeLevel: 'MEDIUM' },
    },
  });

  return res.data;
}

async function getWalletTokenId(walletId, { symbol, tokenAddress } = {}) {
  const balances = await getWalletBalance(walletId);
  const normalizedAddress = tokenAddress ? tokenAddress.toLowerCase() : null;
  const exact = balances.find((entry) => {
    const token = entry?.token || {};
    return normalizedAddress && String(token.tokenAddress || '').toLowerCase() === normalizedAddress;
  });
  const bySymbol = balances.find((entry) => {
    const token = entry?.token || {};
    return String(token.symbol || '').toUpperCase() === String(symbol || '').toUpperCase();
  });
  const token = (exact || bySymbol)?.token;
  if (!token?.id) {
    throw new Error(`${symbol || 'Token'} is not available in this Circle wallet`);
  }
  return token.id;
}

function findTransactionHash(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(txHash|transactionHash|hash)$/i.test(key) && typeof entry === 'string' && /^0x[a-fA-F0-9]{64}$/.test(entry)) {
      return entry;
    }
    const nested = findTransactionHash(entry);
    if (nested) return nested;
  }
  return null;
}

function findTransactionId(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(id|transactionId)$/i.test(key) && typeof entry === 'string') return entry;
    const nested = findTransactionId(entry);
    if (nested) return nested;
  }
  return null;
}

async function waitForTransactionHash(transaction) {
  const immediateHash = findTransactionHash(transaction);
  if (immediateHash) return immediateHash;

  const transactionId = findTransactionId(transaction);
  if (!transactionId) return null;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    const status = await getTransactionStatus(transactionId);
    const hash = findTransactionHash(status);
    if (hash) return hash;
  }
  return null;
}

/**
 * Get wallet balance
 */
async function getWalletBalance(walletId) {
  const client = getCircleClient();
  if (!client) throw new Error('Circle client not initialized');

  const res = await client.getWalletTokenBalance({ id: walletId });
  return res.data?.tokenBalances || [];
}

/**
 * Get transaction status
 */
async function getTransactionStatus(txId) {
  const client = getCircleClient();
  if (!client) throw new Error('Circle client not initialized');

  const res = await client.getTransaction({ id: txId });
  return res.data;
}

module.exports = {
  getCircleClient,
  createWalletForUser,
  executeContractCall,
  transferTokens,
  getWalletTokenId,
  getWalletBalance,
  getTransactionStatus,
  findTransactionHash,
  findTransactionId,
  waitForTransactionHash,
};
