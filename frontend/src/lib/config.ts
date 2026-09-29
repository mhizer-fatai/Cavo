import { defineChain } from 'viem'
import { arbitrumSepolia, baseSepolia, optimismSepolia, polygonAmoy, sepolia } from 'viem/chains'

// ─── Arc network (single switch: VITE_ARC_NETWORK=testnet|mainnet) ───────────
// The internal home-chain label stays 'Arc_Testnet' everywhere (DB values,
// approval matching); only endpoints, chain ID, and token addresses switch.
const ARC_NETWORK = (import.meta.env.VITE_ARC_NETWORK || 'testnet').toLowerCase()
export const IS_MAINNET = ARC_NETWORK === 'mainnet'
const ARC_CHAIN_ID = Number(import.meta.env.VITE_ARC_CHAIN_ID || (IS_MAINNET ? 5042 : 5042002))
export const ARC_RPC_URL = import.meta.env.VITE_ARC_RPC_URL || (IS_MAINNET ? 'https://rpc.arc-scan.org' : 'https://rpc.testnet.arc.network')
export const ARC_EXPLORER_URL = (import.meta.env.VITE_ARC_EXPLORER_URL || (IS_MAINNET ? 'https://explorer.arc.io' : 'https://testnet.arcscan.app')).replace(/\/$/, '')
const ARC_CHAIN_LABEL = IS_MAINNET ? 'Arc' : 'Arc Testnet'
export const ARC_USDC_ADDRESS = (import.meta.env.VITE_ARC_USDC_ADDRESS || '0x3600000000000000000000000000000000000000') as `0x${string}`
export const ARC_EURC_ADDRESS = (import.meta.env.VITE_ARC_EURC_ADDRESS || (IS_MAINNET ? '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1' : '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a')) as `0x${string}`

// ─── Arc chain ────────────────────────────────────────────────────────────────
export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: ARC_CHAIN_LABEL,
  nativeCurrency: {
    name: 'USD Coin',
    symbol: 'USDC',
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
  },
  blockExplorers: {
    default: {
      name: 'Arc Explorer',
      url: ARC_EXPLORER_URL,
    },
  },
  testnet: !IS_MAINNET,
})

// ─── Token Addresses ──────────────────────────────────────────────────────────
export const TOKENS = {
  USDC: {
    address: ARC_USDC_ADDRESS,
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
    color: '#2563eb',
  },
  EURC: {
    address: ARC_EURC_ADDRESS,
    symbol: 'EURC',
    decimals: 6,
    name: 'Euro Coin',
    color: '#059669',
  },
} as const

export const MULTICHAIN_TOKENS = {
  Base_Sepolia: {
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
  },
  Arbitrum_Sepolia: {
    USDC: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as `0x${string}`,
  },
  Ethereum_Sepolia: {
    USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`,
  },
} as const

export const ARC_TESTNET_CHAIN = 'Arc_Testnet'

export const CAVO_SECURITY_QUESTIONS = [
  'What city were you born in?',
  'What is the name of your first school?',
] as const

export const PAYMENT_SOURCE_CHAINS = [
  {
    value: 'Arc_Testnet',
    label: ARC_CHAIN_LABEL,
    wagmiChain: arcTestnet,
    explorer: `${ARC_EXPLORER_URL}/tx/`,
  },
  {
    value: 'Ethereum_Sepolia',
    label: 'Ethereum Sepolia',
    wagmiChain: sepolia,
    explorer: 'https://sepolia.etherscan.io/tx/',
  },
  {
    value: 'Base_Sepolia',
    label: 'Base Sepolia',
    wagmiChain: baseSepolia,
    explorer: 'https://sepolia.basescan.org/tx/',
  },
  {
    value: 'Arbitrum_Sepolia',
    label: 'Arbitrum Sepolia',
    wagmiChain: arbitrumSepolia,
    explorer: 'https://sepolia.arbiscan.io/tx/',
  },
  {
    value: 'Optimism_Sepolia',
    label: 'OP Sepolia',
    wagmiChain: optimismSepolia,
    explorer: 'https://sepolia-optimism.etherscan.io/tx/',
  },
  {
    value: 'Polygon_Amoy_Testnet',
    label: 'Polygon Amoy',
    wagmiChain: polygonAmoy,
    explorer: 'https://amoy.polygonscan.com/tx/',
  },
] as const

export type PaymentSourceChain = typeof PAYMENT_SOURCE_CHAINS[number]['value']

export function getPaymentSourceChain(value: string) {
  return PAYMENT_SOURCE_CHAINS.find(chain => chain.value === value) || PAYMENT_SOURCE_CHAINS[0]
}

// Withdraw destinations: any EOA reachable via Circle CCTP (EVM + Solana).
// Kept separate from the wagmi-bound list above because Solana has no viem chain.
export const CCTP_WITHDRAW_CHAINS = [
  { value: 'Arc_Testnet', label: ARC_CHAIN_LABEL, explorer: `${ARC_EXPLORER_URL}/tx/`, addressKind: 'evm' },
  { value: 'Ethereum_Sepolia', label: 'Ethereum Sepolia', explorer: 'https://sepolia.etherscan.io/tx/', addressKind: 'evm' },
  { value: 'Base_Sepolia', label: 'Base Sepolia', explorer: 'https://sepolia.basescan.org/tx/', addressKind: 'evm' },
  { value: 'Arbitrum_Sepolia', label: 'Arbitrum Sepolia', explorer: 'https://sepolia.arbiscan.io/tx/', addressKind: 'evm' },
  { value: 'Optimism_Sepolia', label: 'OP Sepolia', explorer: 'https://sepolia-optimism.etherscan.io/tx/', addressKind: 'evm' },
  { value: 'Polygon_Amoy_Testnet', label: 'Polygon Amoy', explorer: 'https://amoy.polygonscan.com/tx/', addressKind: 'evm' },
  { value: 'Avalanche_Fuji', label: 'Avalanche Fuji', explorer: 'https://testnet.snowtrace.io/tx/', addressKind: 'evm' },
  { value: 'Unichain_Sepolia', label: 'Unichain Sepolia', explorer: 'https://sepolia.uniscan.xyz/tx/', addressKind: 'evm' },
  { value: 'Solana_Devnet', label: 'Solana Devnet', explorer: 'https://explorer.solana.com/tx/', explorerSuffix: '?cluster=devnet', addressKind: 'solana' },
] as const

export function getWithdrawChain(value: string) {
  return CCTP_WITHDRAW_CHAINS.find(chain => chain.value === value) || CCTP_WITHDRAW_CHAINS[0]
}

export function isValidWithdrawAddress(chainValue: string, address: string): boolean {
  const chain = getWithdrawChain(chainValue)
  const text = address.trim()
  if (chain.addressKind === 'solana') {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)
  }
  return /^0x[a-fA-F0-9]{40}$/.test(text)
}

export type TokenSymbol = keyof typeof TOKENS

// ─── Contract ─────────────────────────────────────────────────────────────────
export const CAVO_CONTRACT_ADDRESS = (
  import.meta.env.VITE_CAVO_CONTRACT_ADDRESS ||
  '0xE5DEcbeEED2CFc9C59999F902Cc78Bb5fE96aC4E'
) as `0x${string}`

// ─── Backend ──────────────────────────────────────────────────────────────────
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '/api'
