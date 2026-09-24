const { AppKit } = require("@circle-fin/app-kit");
const { createCircleWalletsAdapter } = require("@circle-fin/adapter-circle-wallets");

const SOURCE_CHAIN = "Arc_Testnet";

const SUPPORTED_DESTINATION_CHAINS = Object.freeze({
  Arc_Testnet: {
    value: "Arc_Testnet",
    label: "Arc Testnet",
    explorer: "https://testnet.arcscan.app/tx/",
  },
  Ethereum_Sepolia: {
    value: "Ethereum_Sepolia",
    label: "Ethereum Sepolia",
    explorer: "https://sepolia.etherscan.io/tx/",
  },
  Base_Sepolia: {
    value: "Base_Sepolia",
    label: "Base Sepolia",
    explorer: "https://sepolia.basescan.org/tx/",
  },
  Arbitrum_Sepolia: {
    value: "Arbitrum_Sepolia",
    label: "Arbitrum Sepolia",
    explorer: "https://sepolia.arbiscan.io/tx/",
  },
  Optimism_Sepolia: {
    value: "Optimism_Sepolia",
    label: "OP Sepolia",
    explorer: "https://sepolia-optimism.etherscan.io/tx/",
  },
  Polygon_Amoy_Testnet: {
    value: "Polygon_Amoy_Testnet",
    label: "Polygon Amoy",
    explorer: "https://amoy.polygonscan.com/tx/",
  },
  Avalanche_Fuji: {
    value: "Avalanche_Fuji",
    label: "Avalanche Fuji",
    explorer: "https://testnet.snowtrace.io/tx/",
  },
  Unichain_Sepolia: {
    value: "Unichain_Sepolia",
    label: "Unichain Sepolia",
    explorer: "https://sepolia.uniscan.xyz/tx/",
  },
  Solana_Devnet: {
    value: "Solana_Devnet",
    label: "Solana Devnet",
    explorer: "https://explorer.solana.com/tx/",
    explorerSuffix: "?cluster=devnet",
    nonEvm: "solana",
  },
});

let adapter;
let kit;

function getCircleWalletsKit() {
  if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
    throw Object.assign(new Error("Circle API key and entity secret are required for Arc App Kit sends"), { status: 500 });
  }
  if (!adapter) {
    adapter = createCircleWalletsAdapter({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });
  }
  if (!kit) kit = new AppKit();
  return { adapter, kit };
}

function normalizeDestinationChain(value) {
  const chain = String(value || SOURCE_CHAIN).trim();
  if (!SUPPORTED_DESTINATION_CHAINS[chain]) {
    throw Object.assign(new Error("Unsupported destination chain"), { status: 400 });
  }
  return chain;
}

function isSolanaChain(chain) {
  return !!SUPPORTED_DESTINATION_CHAINS[chain]?.nonEvm;
}

function isValidAddressForChain(chain, address) {
  const text = String(address || "").trim();
  if (isSolanaChain(chain)) {
    // Base58-encoded 32-byte ed25519 address (case-sensitive — never lowercase).
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
  }
  return /^0x[a-fA-F0-9]{40}$/.test(text);
}

function normalizeAccountAddress(chain, address) {
  const text = String(address || "").trim();
  // EVM addresses are checksummed-insensitive hex: lowercase for comparison.
  // Solana addresses are case-sensitive base58: preserve exactly.
  return isSolanaChain(chain) ? text : text.toLowerCase();
}

function getBridgeTransactionHash(result) {
  if (!result || typeof result !== "object") return null;
  if (Array.isArray(result)) {
    for (const entry of result) {
      const hash = getBridgeTransactionHash(entry);
      if (hash) return hash;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(result)) {
    if (/^(txHash|transactionHash|hash)$/i.test(key) && typeof entry === "string" && /^0x[a-fA-F0-9]{64}$/.test(entry)) {
      return entry;
    }
    const nested = getBridgeTransactionHash(entry);
    if (nested) return nested;
  }
  return null;
}

function toJsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toJsonSafe(entry)])
  );
}

async function bridgeUsdcFromArc({ fromAddress, toAddress, destinationChain, amount }) {
  const chain = normalizeDestinationChain(destinationChain);
  if (chain === SOURCE_CHAIN) {
    throw Object.assign(new Error("Use a same-chain send for Arc Testnet transfers"), { status: 400 });
  }

  const { adapter: circleAdapter, kit: appKit } = getCircleWalletsKit();
  const result = await appKit.bridge({
    from: {
      adapter: circleAdapter,
      chain: SOURCE_CHAIN,
      address: fromAddress,
    },
    to: {
      chain,
      recipientAddress: toAddress,
      useForwarder: true,
    },
    amount,
    token: "USDC",
  });

  return {
    result: toJsonSafe(result),
    state: result?.state || "pending",
    txHash: getBridgeTransactionHash(result),
  };
}

module.exports = {
  SOURCE_CHAIN,
  SUPPORTED_DESTINATION_CHAINS,
  bridgeUsdcFromArc,
  getCircleWalletsKit,
  findResultTransactionHash: getBridgeTransactionHash,
  toJsonSafe,
  normalizeDestinationChain,
  isSolanaChain,
  isValidAddressForChain,
  normalizeAccountAddress,
};
