import { AppKit } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { ARC_TESTNET_CHAIN, getPaymentSourceChain, type PaymentSourceChain } from './config'

let kit: AppKit | null = null

function getKit() {
  if (!kit) kit = new AppKit()
  return kit
}

function findTxHash(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(record)) {
    if (/^(txHash|transactionHash|hash)$/i.test(key) && typeof entry === 'string' && /^0x[a-fA-F0-9]{64}$/.test(entry)) {
      return entry
    }
    const nested = findTxHash(entry)
    if (nested) return nested
  }
  return null
}

export async function bridgePaymentToArc(params: {
  sourceChain: PaymentSourceChain
  recipientAddress: string
  amount: string
}) {
  if (params.sourceChain === ARC_TESTNET_CHAIN) {
    throw new Error('Arc payments should use the direct Arc payment flow')
  }
  const provider = (window as any).ethereum
  if (!provider) throw new Error('No browser wallet provider found')

  const adapter = await createViemAdapterFromProvider({
    provider,
    capabilities: { addressContext: 'user-controlled' },
  })

  const source = getPaymentSourceChain(params.sourceChain)
  const result = await getKit().bridge({
    from: {
      adapter,
      chain: params.sourceChain,
    },
    to: {
      chain: ARC_TESTNET_CHAIN,
      recipientAddress: params.recipientAddress,
      useForwarder: true,
    },
    amount: params.amount,
    token: 'USDC',
  })

  return {
    result,
    source,
    state: (result as any)?.state || 'submitted',
    txHash: findTxHash(result),
  }
}
