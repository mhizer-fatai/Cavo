import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { arcTestnet } from './config'
import { baseSepolia, arbitrumSepolia, optimismSepolia, polygonAmoy, sepolia } from 'viem/chains'

export const wagmiConfig = createConfig({
  chains: [arcTestnet, baseSepolia, arbitrumSepolia, optimismSepolia, polygonAmoy, sepolia],
  connectors: [
    injected(), // Handles MetaMask, TrustWallet, etc.
  ],
  transports: {
    [arcTestnet.id]: http('https://rpc.testnet.arc.network'),
    [baseSepolia.id]: http('https://base-sepolia-rpc.publicnode.com'),
    [arbitrumSepolia.id]: http('https://arbitrum-sepolia-rpc.publicnode.com'),
    [optimismSepolia.id]: http('https://optimism-sepolia-rpc.publicnode.com'),
    [polygonAmoy.id]: http('https://polygon-amoy-bor-rpc.publicnode.com'),
    [sepolia.id]: http('https://ethereum-sepolia-rpc.publicnode.com'),
  },
})
