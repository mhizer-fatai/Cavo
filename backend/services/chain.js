// Single network switch for Arc: ARC_NETWORK=testnet (default) or mainnet.
//
// The app's internal home-chain label stays "Arc_Testnet" everywhere (stored
// in the DB, sent by clients, matched in approvals). Only the SDK-facing
// chain name, endpoints, chain ID, and token addresses switch here.
const NETWORK = String(process.env.ARC_NETWORK || "testnet").toLowerCase().trim();
const IS_MAINNET = NETWORK === "mainnet";

// Circle SDK Blockchain enum value for the home chain.
const SDK_CHAIN = IS_MAINNET ? "Arc" : "Arc_Testnet";
const CHAIN_ID = IS_MAINNET ? 5042 : 5042002;

const RPC_URL =
  process.env.ARC_RPC_URL ||
  (IS_MAINNET ? "https://rpc.arc-scan.org" : "https://rpc.testnet.arc.network");

const EXPLORER_URL = (
  process.env.ARC_EXPLORER_URL ||
  (IS_MAINNET ? "https://explorer.arc.io" : "https://testnet.arcscan.app")
).replace(/\/$/, "");
const EXPLORER_TX = `${EXPLORER_URL}/tx/`;

// USDC keeps the same address on mainnet. EURC mainnet:
/// 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1 (verified on explorer.arc.io).
const USDC_ADDRESS =
  process.env.ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const EURC_ADDRESS =
  process.env.ARC_EURC_ADDRESS ||
  (IS_MAINNET
    ? "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1"
    : "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");

const ARCSCAN_API_BASE =
  process.env.ARCSCAN_API_BASE ||
  (IS_MAINNET ? "https://api.arc-scan.org/api" : "https://testnet.arcscan.app/api");

// Testnet-only public RPC fallbacks (never used on mainnet).
const RPC_FALLBACKS = IS_MAINNET
  ? []
  : [
      "https://rpc.quicknode.testnet.arc.network",
      "https://arc-testnet.drpc.org",
    ];

module.exports = {
  NETWORK,
  IS_MAINNET,
  SDK_CHAIN,
  CHAIN_ID,
  RPC_URL,
  RPC_FALLBACKS,
  EXPLORER_URL,
  EXPLORER_TX,
  USDC_ADDRESS,
  EURC_ADDRESS,
  ARCSCAN_API_BASE,
};
