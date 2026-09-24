import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatUnits, parseUnits } from 'viem'
import { Link as LinkIcon, RefreshCw, Shield, Users, X } from 'lucide-react'
import Navbar from '../components/Navbar'
import WalletButton from '../components/WalletButton'
import CopyButton from '../components/CopyButton'
import PinDotsInput from '../components/PinDotsInput'
import PaymentSuccessCelebration from '../components/PaymentSuccessCelebration'
import ScanQrModal from '../components/ScanQrModal'
import BalanceCard from '../features/dashboard/BalanceCard'
import QuickActions from '../features/dashboard/QuickActions'
import TransactionList, { type LedgerPayment, type LedgerTab } from '../features/dashboard/TransactionList'
import ContactsPanel, { type ContactEntry, type ContactTab } from '../features/contacts/ContactsPanel'
import SendPaymentModal, { type PendingSend, type SendStep, type SendToken } from '../features/send/SendPaymentModal'
import WithdrawModal, { type WithdrawStep } from '../features/withdraw/WithdrawModal'
import ReceiveModal from '../features/receive/ReceiveModal'
import SwapModal, { type SwapStep, type SwapToken } from '../features/swap/SwapModal'
import EarnModal, { type EarnMode, type EarnStep, type EarnToken } from '../features/earn/EarnModal'
import EarnSection from '../features/earn/EarnSection'
import type { BridgeStage } from '../components/BridgeStatusTimeline'
import { ARC_TESTNET_CHAIN, PAYMENT_SOURCE_CHAINS, CAVO_SECURITY_QUESTIONS, CCTP_WITHDRAW_CHAINS, TOKENS, getPaymentSourceChain, isValidWithdrawAddress } from '../lib/config'
import {
  approveCavoPinTransaction,
  bridgeDeveloperControlledTransfer,
  claimProfile,
  createDeveloperControlledWallet,
  createPaymentLink,
  depositEarn,
  executeSwap,
  getCreatorPayments,
  getDeveloperControlledWallet,
  getEarnHistory,
  getEarnPositions,
  getEarnVaults,
  getPayerPayments,
  getCavoPinStatus,
  getProfile,
  getProfileByWallet,
  getSwapHistory,
  getSwapQuote,
  getTokenBalance,
  getTokenTransfers,
  getWalletTransactionStatus,
  logPayment,
  sendDeveloperControlledTransfer,
  setupCavoPin,
  updateProfileAvatar,
  withdrawEarn,
  type CircleWallet,
  type EarnEvent,
  type EarnPosition,
  type EarnVault,
  type Payment,
  type Profile,
  type SwapQuote,
  type SwapRecord,
} from '../lib/api'
import { useCavoAuth } from '../context/AuthContext'

type Section = 'dashboard' | 'history' | 'contacts' | 'links'

const DESTINATION_CHAINS = PAYMENT_SOURCE_CHAINS.map(chain => ({
  value: chain.value,
  label: chain.label,
}))

const shorten = (address?: string | null) => {
  if (!address) return 'Unknown'
  if (address.startsWith('@')) return address
  if (address.length < 12) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const getDestinationChainLabel = (value?: string) =>
  DESTINATION_CHAINS.find(chain => chain.value === value)?.label
  || CCTP_WITHDRAW_CHAINS.find(chain => chain.value === value)?.label
  || 'Arc Testnet'

function getTxHash(value: any): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const hash = getTxHash(item)
      if (hash) return hash
    }
    return undefined
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/^(txHash|transactionHash|hash)$/i.test(key) && typeof entry === 'string' && /^0x[a-fA-F0-9]{64}$/.test(entry)) {
      return entry
    }
    const nested = getTxHash(entry)
    if (nested) return nested
  }
  return undefined
}

function paymentExplorerUrl(payment: Payment) {
  if (!payment.tx_hash) return '#'
  const chain = getPaymentSourceChain(payment.source_chain || payment.destination_chain || ARC_TESTNET_CHAIN)
  return `${chain.explorer}${payment.tx_hash}`
}

function normalizeAddress(value?: string | null) {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

function formatLedgerAddress(value?: string | null, profileMap?: Record<string, Profile>) {
  const key = normalizeAddress(value)
  if (key && profileMap?.[key]) return `@${profileMap[key].username}`
  return shorten(value)
}

function mergePayments(logged: LedgerPayment[], onchain: LedgerPayment[]) {
  const seen = new Set<string>()
  const merged: LedgerPayment[] = []

  for (const payment of [...logged, ...onchain]) {
    const key = payment.tx_hash ? payment.tx_hash.toLowerCase() : payment.id
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(payment)
  }

  return merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

/**
 * Combine the two on-chain legs of a swap (outgoing tokenIn + incoming tokenOut
 * sharing one tx hash) into a single 'swap' row. Without this, a swap shows up
 * as a confusing standalone "received" row — and mergePayments would silently
 * drop one of the two legs because they share a tx hash.
 */
function combineSwapLegs(rows: LedgerPayment[], selfAddress: string): { swaps: LedgerPayment[]; rest: LedgerPayment[] } {
  const self = normalizeAddress(selfAddress)
  const byHash = new Map<string, LedgerPayment[]>()
  for (const row of rows) {
    const key = row.tx_hash ? row.tx_hash.toLowerCase() : `nohash-${row.id}`
    const list = byHash.get(key) || []
    list.push(row)
    byHash.set(key, list)
  }

  const swaps: LedgerPayment[] = []
  const rest: LedgerPayment[] = []
  for (const [key, group] of byHash) {
    if (group.length < 2 || !group[0].tx_hash) {
      rest.push(...group)
      continue
    }
    const outLeg = group
      .filter(item => item.type === 'sent')
      .sort((a, b) => Number(b.amount) - Number(a.amount))[0]
    const inLeg = group
      .filter(item => item.type === 'received')
      .sort((a, b) => Number(b.amount) - Number(a.amount))[0]
    if (outLeg && inLeg && outLeg.token !== inLeg.token) {
      const createdAt = group.map(item => item.created_at).sort()[0]
      swaps.push({
        ...outLeg,
        id: `swap-${key}`,
        payer_address: self,
        recipient_address: self,
        type: 'swap',
        created_at: createdAt,
        swap: {
          tokenIn: outLeg.token,
          amountIn: Number(outLeg.amount),
          tokenOut: inLeg.token,
          amountOut: Number(inLeg.amount),
        },
      })
    } else {
      rest.push(...group)
    }
  }
  return { swaps, rest }
}

/** A logged row where payer == recipient == self is a swap marker, never a receive. */
function isSelfSwapRow(payment: { tx_hash?: string | null; payer_address?: string | null; recipient_address?: string | null }, selfAddress: string): boolean {
  return !!payment.tx_hash
    && normalizeAddress(payment.payer_address) === normalizeAddress(selfAddress)
    && normalizeAddress(payment.recipient_address) === normalizeAddress(selfAddress)
}

/** Map a backend swap record to one unique 'swap' ledger row. */
function swapRecordToRow(record: SwapRecord, selfAddress: string): LedgerPayment {
  const tokenIn = String(record.token_in || '').toUpperCase()
  const tokenOut = String(record.token_out || '').toUpperCase()
  return {
    id: `swap-record-${record.id}`,
    link_id: '',
    payer_address: selfAddress,
    recipient_address: selfAddress,
    source_chain: ARC_TESTNET_CHAIN,
    destination_chain: ARC_TESTNET_CHAIN,
    tx_hash: record.tx_hash || '',
    amount: Number(record.amount_in) || 0,
    token: tokenIn,
    created_at: record.created_at,
    type: 'swap',
    swap: {
      tokenIn,
      amountIn: Number(record.amount_in) || 0,
      tokenOut,
      amountOut: record.amount_out != null ? Number(record.amount_out) : null,
    },
  }
}

const SWAP_LEG_MATCH_WINDOW_MS = 10 * 60 * 1000

function amountsEqual(a: number, b: number) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6
}

/**
 * Check whether an on-chain leg is already represented by a backend swap record
 * (same tx hash, or same token + amount within minutes of the swap). Consumed
 * legs are hidden so a swap never also shows up as a stray "received" row.
 */
function onchainLegBelongsToSwap(leg: LedgerPayment, swapRows: LedgerPayment[]): boolean {
  if (leg.type === 'swap') return false
  return swapRows.some(row => {
    if (row.tx_hash && leg.tx_hash && row.tx_hash.toLowerCase() === leg.tx_hash.toLowerCase()) return true
    const legs = row.swap
    if (!legs) return false
    const legTime = new Date(leg.created_at).getTime()
    const rowTime = new Date(row.created_at).getTime()
    if (!Number.isFinite(legTime) || !Number.isFinite(rowTime)) return false
    if (Math.abs(legTime - rowTime) > SWAP_LEG_MATCH_WINDOW_MS) return false
    const legAmount = Number(leg.amount)
    if (leg.type === 'sent' && leg.token === legs.tokenIn && amountsEqual(legAmount, Number(legs.amountIn))) return true
    if (leg.type === 'received' && legs.amountOut != null && leg.token === legs.tokenOut && amountsEqual(legAmount, Number(legs.amountOut))) return true
    return false
  })
}

function resizeAvatarFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Choose an image file'))
      return
    }

    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read image'))
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => reject(new Error('Could not load image'))
      image.onload = () => {
        const size = 320
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error('Could not prepare image'))
          return
        }

        const scale = Math.max(size / image.width, size / image.height)
        const width = image.width * scale
        const height = image.height * scale
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      }
      image.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

export default function DashboardPage() {
  const { user: authUser } = useCavoAuth()
  const navigate = useNavigate()
  const isLoggedIn = !!authUser?.cavoSessionToken
  const activeUserKey = authUser?.userKey || ''
  const loginLabel = authUser?.email || ''

  const [section, setSection] = useState<Section>('dashboard')
  const [circleWallet, setCircleWallet] = useState<CircleWallet | null>(null)
  const [walletLoading, setWalletLoading] = useState(false)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [profileMap, setProfileMap] = useState<Record<string, Profile>>({})
  const [missingProfileAddresses, setMissingProfileAddresses] = useState<Record<string, true>>({})

  const [usdcDisplay, setUsdcDisplay] = useState('0.00')
  const [eurcDisplay, setEurcDisplay] = useState('0.00')
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [receivedPayments, setReceivedPayments] = useState<LedgerPayment[]>([])
  const [sentPayments, setSentPayments] = useState<LedgerPayment[]>([])
  const [earnPayments, setEarnPayments] = useState<LedgerPayment[]>([])
  const [ledgerTab, setLedgerTab] = useState<LedgerTab>('all')
  const [miniTab, setMiniTab] = useState<LedgerTab>('all')
  const [historyVisibleCount, setHistoryVisibleCount] = useState(8)
  const [selectedPayment, setSelectedPayment] = useState<LedgerPayment | null>(null)

  const [showClaimModal, setShowClaimModal] = useState(false)
  const [claimName, setClaimName] = useState('')
  const [claimLoading, setClaimLoading] = useState(false)
  const [claimErr, setClaimErr] = useState<string | null>(null)

  const [form, setForm] = useState({ amount: '', token: 'USDC' as SendToken, note: '', recipient: '' })
  const [generatedLink, setGeneratedLink] = useState<string | null>(null)
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [isReceiveModalOpen, setIsReceiveModalOpen] = useState(false)
  const [isScanQrOpen, setIsScanQrOpen] = useState(false)
  const [isSendModalOpen, setIsSendModalOpen] = useState(false)
  const [sendDest, setSendDest] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [sendToken, setSendToken] = useState<SendToken>('USDC')
  const [destinationChain, setDestinationChain] = useState(ARC_TESTNET_CHAIN)
  const [sendStep, setSendStep] = useState<SendStep>('details')
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null)
  const [cavoPin, setCavoPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [securityAnswerOne, setSecurityAnswerOne] = useState('')
  const [securityAnswerTwo, setSecurityAnswerTwo] = useState('')
  const [hasCavoPin, setHasCavoPin] = useState<boolean | null>(null)
  const [showPinSetupModal, setShowPinSetupModal] = useState(false)
  const [pinSetupLoading, setPinSetupLoading] = useState(false)
  const [pinSetupError, setPinSetupError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [bridgeStage, setBridgeStage] = useState<BridgeStage>('idle')
  const [sendSuccess, setSendSuccess] = useState<{ amount: string; token: string; recipient: string; txHash?: string } | null>(null)
  const [scannedRecipient, setScannedRecipient] = useState<Profile | null>(null)

  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false)
  const [withdrawStep, setWithdrawStep] = useState<WithdrawStep>('details')
  const [withdrawAddress, setWithdrawAddress] = useState('')
  const [withdrawChain, setWithdrawChain] = useState<string>(ARC_TESTNET_CHAIN)
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [isWithdrawing, setIsWithdrawing] = useState(false)
  const [withdrawSuccess, setWithdrawSuccess] = useState<{ amount: string; recipient: string; chain: string; txHash?: string } | null>(null)

  const [isSwapModalOpen, setIsSwapModalOpen] = useState(false)
  const [swapStep, setSwapStep] = useState<SwapStep>('details')
  const [swapAmount, setSwapAmount] = useState('')
  const [swapTokenIn, setSwapTokenIn] = useState<SwapToken>('USDC')
  const [swapQuote, setSwapQuote] = useState<SwapQuote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [swapError, setSwapError] = useState<string | null>(null)
  const [isSwapping, setIsSwapping] = useState(false)
  const [swapSuccess, setSwapSuccess] = useState<{
    amountIn: string
    tokenIn: string
    amountOut: string
    tokenOut: string
    txHash?: string
  } | null>(null)

  const [isEarnModalOpen, setIsEarnModalOpen] = useState(false)
  const [earnMode, setEarnMode] = useState<EarnMode>('deposit')
  const [earnStep, setEarnStep] = useState<EarnStep>('details')
  const [earnAmount, setEarnAmount] = useState('')
  const [earnToken, setEarnToken] = useState<EarnToken>('USDC')
  const [earnError, setEarnError] = useState<string | null>(null)
  const [isEarning, setIsEarning] = useState(false)
  const [earnVaults, setEarnVaults] = useState<EarnVault[]>([])
  const [earnVaultsLoading, setEarnVaultsLoading] = useState(false)
  const [earnPositions, setEarnPositions] = useState<EarnPosition[]>([])
  const [earnSuccess, setEarnSuccess] = useState<{
    mode: EarnMode
    amount: string
    token: string
    shares: string
    shareSymbol: string
    txHash?: string
    destinationChain?: string
    destinationLabel?: string
  } | null>(null)

  const [contactTab, setContactTab] = useState<ContactTab>('recent')
  const [favorites, setFavorites] = useState<ContactEntry[]>([])
  const refreshTimer = useRef<number | null>(null)
  // Stale-while-revalidate ledger sync: render cache instantly, sync in background.
  const [ledgerSyncing, setLedgerSyncing] = useState(false)
  const ledgerHydrated = useRef(false)
  const ledgerRefreshInFlight = useRef(false)
  const lastLedgerRefreshAt = useRef(0)
  const LEDGER_MIN_REFRESH_MS = 15000
  const quoteRequestSeq = useRef(0)
  const profileLookupInFlight = useRef<Set<string>>(new Set())
  const avatarInputRef = useRef<HTMLInputElement | null>(null)

  const cavoWalletAddress = circleWallet?.walletAddress || ''

  const allPayments = useMemo(() => {
    const received = receivedPayments.map(payment => ({ ...payment, type: 'received' as const }))
    const sent = sentPayments.map(payment => (
      payment.type === 'swap' ? payment : { ...payment, type: 'sent' as const }
    ))
    const earn = earnPayments.map(payment => ({ ...payment, type: 'earn' as const }))
    const merged = mergePayments(mergePayments(received, sent), earn)
    if (ledgerTab === 'received') return merged.filter(payment => payment.type === 'received')
    if (ledgerTab === 'sent') return merged.filter(payment => payment.type === 'sent')
    if (ledgerTab === 'swaps') return merged.filter(payment => payment.type === 'swap')
    if (ledgerTab === 'earn') return merged.filter(payment => payment.type === 'earn')
    return merged
  }, [ledgerTab, receivedPayments, sentPayments, earnPayments])

  const dashboardPayments = useMemo(() => mergePayments(
    mergePayments(
      receivedPayments.map(payment => ({ ...payment, type: 'received' as const })),
      sentPayments.map(payment => (
        payment.type === 'swap' ? payment : { ...payment, type: 'sent' as const }
      )),
    ),
    earnPayments.map(payment => ({ ...payment, type: 'earn' as const })),
  ), [receivedPayments, sentPayments, earnPayments])

  // Swaps live inside sentPayments (money left the wallet) but get their own
  // tab and counts so every transaction type stays specific.
  const sentOnlyPayments = useMemo(
    () => sentPayments.filter(payment => payment.type !== 'swap'),
    [sentPayments],
  )
  const swapOnlyPayments = useMemo(
    () => sentPayments.filter(payment => payment.type === 'swap'),
    [sentPayments],
  )

  // Dashboard mini-list has its own tab state so it filters independently.
  const miniPayments = useMemo(() => {
    if (miniTab === 'received') return dashboardPayments.filter(payment => payment.type === 'received')
    if (miniTab === 'sent') return dashboardPayments.filter(payment => payment.type === 'sent')
    if (miniTab === 'swaps') return dashboardPayments.filter(payment => payment.type === 'swap')
    if (miniTab === 'earn') return dashboardPayments.filter(payment => payment.type === 'earn')
    return dashboardPayments
  }, [dashboardPayments, miniTab])

  const favoritesKey = activeUserKey ? `cavo.contacts.favorites:${activeUserKey}` : ''

  const updateWalletAddressCache = (walletAddress: string) => {
    if (!authUser?.userKey || !walletAddress) return
    localStorage.setItem(`cavo.walletAddress:${authUser.userKey}`, walletAddress)
    window.dispatchEvent(new CustomEvent('cavo:wallet-address-updated', {
      detail: { userKey: authUser.userKey, walletAddress },
    }))
  }

  const getBalanceCacheKey = (walletAddress: string) => `cavo.balances:${normalizeAddress(walletAddress)}`

  const loadCachedBalances = (walletAddress: string) => {
    try {
      const cached = JSON.parse(localStorage.getItem(getBalanceCacheKey(walletAddress)) || '{}')
      if (typeof cached.usdc === 'string') setUsdcDisplay(cached.usdc)
      if (typeof cached.eurc === 'string') setEurcDisplay(cached.eurc)
    } catch {
      // Bad cache should never block fresh balance loading.
    }
  }

  const saveBalanceCache = (walletAddress: string, usdc: string, eurc: string) => {
    localStorage.setItem(getBalanceCacheKey(walletAddress), JSON.stringify({
      usdc,
      eurc,
      updatedAt: Date.now(),
    }))
  }

  const getLedgerCacheKey = (walletAddress: string) => `cavo.ledger:${normalizeAddress(walletAddress)}`

  const loadCachedLedger = (walletAddress: string): boolean => {
    try {
      const cached = JSON.parse(localStorage.getItem(getLedgerCacheKey(walletAddress)) || '{}')
      if (Array.isArray(cached.received) && Array.isArray(cached.sent)) {
        setReceivedPayments(cached.received)
        setSentPayments(cached.sent)
        if (Array.isArray(cached.earn)) setEarnPayments(cached.earn)
        ledgerHydrated.current = true
        return true
      }
    } catch {
      // Bad cache should never block fresh loading.
    }
    return false
  }

  const saveLedgerCache = (walletAddress: string, received: LedgerPayment[], sent: LedgerPayment[], earn: LedgerPayment[]) => {
    try {
      localStorage.setItem(getLedgerCacheKey(walletAddress), JSON.stringify({
        received,
        sent,
        earn,
        updatedAt: Date.now(),
      }))
    } catch {
      // Quota errors are non-fatal; the next sync simply refetches.
    }
  }

  const refreshProfileMap = async (addresses: string[]) => {
    const unique = Array.from(new Set(addresses.map(normalizeAddress).filter(Boolean)))
    const lookupTargets = unique.filter(item =>
      !profileMap[item]
      && !missingProfileAddresses[item]
      && !profileLookupInFlight.current.has(item)
    )
    if (lookupTargets.length === 0) return

    lookupTargets.forEach(item => profileLookupInFlight.current.add(item))
    const entries = await Promise.all(lookupTargets.map(async walletAddress => {
      try {
        const nextProfile = await getProfileByWallet(walletAddress)
        return nextProfile ? [walletAddress, nextProfile] as const : null
      } catch {
        return null
      } finally {
        profileLookupInFlight.current.delete(walletAddress)
      }
    }))

    const found = Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, Profile]>)
    if (Object.keys(found).length > 0) {
      setProfileMap(previous => ({ ...previous, ...found }))
    }
    const foundKeys = new Set(Object.keys(found))
    const notFound = lookupTargets.filter(item => !foundKeys.has(item))
    if (notFound.length > 0) {
      setMissingProfileAddresses(previous => {
        const next = { ...previous }
        notFound.forEach(item => { next[item] = true })
        return next
      })
    }
  }

  const refreshWallet = async () => {
    if (!activeUserKey) return
    setWalletLoading(true)
    setWalletError(null)
    try {
      let wallet = await getDeveloperControlledWallet(activeUserKey)
      if (!wallet.exists || !wallet.walletAddress) {
        wallet = await createDeveloperControlledWallet(activeUserKey)
      }
      setCircleWallet(wallet)
      updateWalletAddressCache(wallet.walletAddress)

      const ownerKey = wallet.ownerUserKey || activeUserKey
      const nextProfile = await getProfileByWallet(ownerKey)
        .catch(() => null)
        || await getProfileByWallet(wallet.walletAddress).catch(() => null)
      setProfile(nextProfile)
      if (nextProfile) {
        setProfileMap(previous => ({
          ...previous,
          [normalizeAddress(ownerKey)]: nextProfile,
          [normalizeAddress(wallet.walletAddress)]: nextProfile,
        }))
      }
      setShowClaimModal(!nextProfile)
    } catch (error: any) {
      setWalletError(error.message || 'Failed to load Cavo wallet')
    } finally {
      setWalletLoading(false)
    }
  }

  const refreshBalances = async () => {
    if (!cavoWalletAddress) return
    setBalanceLoading(true)
    try {
      const [usdc, eurc] = await Promise.all([
        getTokenBalance(cavoWalletAddress, TOKENS.USDC.address),
        getTokenBalance(cavoWalletAddress, TOKENS.EURC.address),
      ])
      const nextUsdc = Number(formatUnits(usdc, TOKENS.USDC.decimals)).toFixed(2)
      const nextEurc = Number(formatUnits(eurc, TOKENS.EURC.decimals)).toFixed(2)
      setUsdcDisplay(nextUsdc)
      setEurcDisplay(nextEurc)
      saveBalanceCache(cavoWalletAddress, nextUsdc, nextEurc)
    } catch (error) {
      console.warn('Balance refresh failed:', error)
    } finally {
      setBalanceLoading(false)
    }
  }

  const getOnchainTokenTransfers = async (walletAddress: string) => {
    const transfers = await Promise.all([
      getTokenTransfers(walletAddress, TOKENS.USDC.address).catch(() => []),
      getTokenTransfers(walletAddress, TOKENS.EURC.address).catch(() => []),
    ])

    return transfers.flat().map((transfer: any): LedgerPayment => {
      const token = (transfer.tokenSymbol || transfer.tokenName || '').toUpperCase().includes('EUR') ? 'EURC' : 'USDC'
      const decimals = Number(transfer.tokenDecimal || TOKENS[token as SendToken].decimals)
      const rawValue = BigInt(transfer.value || 0)
      const from = transfer.from || ''
      const to = transfer.to || ''
      const isReceived = normalizeAddress(to) === normalizeAddress(walletAddress)
      return {
        id: `chain-${transfer.hash}-${transfer.logIndex || transfer.transactionIndex || ''}-${isReceived ? 'in' : 'out'}`,
        link_id: '',
        payer_address: from,
        recipient_address: to,
        destination_chain: ARC_TESTNET_CHAIN,
        source_chain: ARC_TESTNET_CHAIN,
        tx_hash: transfer.hash,
        amount: Number(formatUnits(rawValue, decimals)),
        token,
        created_at: transfer.timeStamp ? new Date(Number(transfer.timeStamp) * 1000).toISOString() : new Date().toISOString(),
        type: isReceived ? 'received' : 'sent',
      }
    })
  }

  const refreshLedger = async (options?: { force?: boolean }) => {
    if (!cavoWalletAddress) return
    // Stale-while-revalidate: skip overlapping or too-frequent syncs unless forced
    // (e.g. right after a send/swap). The list keeps showing cached data meanwhile.
    if (ledgerRefreshInFlight.current) return
    if (!options?.force && Date.now() - lastLedgerRefreshAt.current < LEDGER_MIN_REFRESH_MS) return
    ledgerRefreshInFlight.current = true
    lastLedgerRefreshAt.current = Date.now()
    // Full-page loader only on cold start with zero cached data; otherwise sync quietly.
    const coldStart = !ledgerHydrated.current
    if (coldStart) setLedgerLoading(true)
    else setLedgerSyncing(true)
    try {
      const [creatorRows, payerRows, onchainRows] = await Promise.all([
        getCreatorPayments(cavoWalletAddress),
        getPayerPayments(cavoWalletAddress),
        getOnchainTokenTransfers(cavoWalletAddress),
      ])
      const swapRecords = activeUserKey
        ? await getSwapHistory(activeUserKey).catch((): SwapRecord[] => [])
        : []
      const earnEvents = activeUserKey
        ? await getEarnHistory(activeUserKey).catch((): EarnEvent[] => [])
        : []
      const receivedLogged = creatorRows
        .filter(payment => !isSelfSwapRow(payment, cavoWalletAddress))
        .map(payment => ({ ...payment, type: 'received' as const }))
      const sentLogged = payerRows.map(payment => ({ ...payment, type: 'sent' as const }))
      // Backend swap records are the source of truth: one record = one unique swap row.
      const swapRows = swapRecords.map(record => swapRecordToRow(record, cavoWalletAddress))
      const unconsumedOnchain = onchainRows.filter(leg => !onchainLegBelongsToSwap(leg, swapRows))
      const { swaps: onchainSwaps, rest: onchainRest } = combineSwapLegs(unconsumedOnchain, cavoWalletAddress)

      // Swaps recorded via logPayment have payer == recipient == self. They show up
      // in BOTH the payer and creator endpoints, so collect candidates from both
      // (deduped by hash) and mark them as swaps with both sides of the conversion.
      const selfSwapCandidates = new Map<string, LedgerPayment>()
      for (const payment of [...sentLogged, ...creatorRows]) {
        if (!isSelfSwapRow(payment, cavoWalletAddress)) continue
        const key = String(payment.tx_hash).toLowerCase()
        if (!selfSwapCandidates.has(key)) {
          selfSwapCandidates.set(key, { ...payment, type: 'sent' as const })
        }
      }
      const consumedSwapHashes = new Set<string>()
      const loggedSwaps: LedgerPayment[] = []
      const sentLoggedRest: LedgerPayment[] = []
      for (const payment of sentLogged) {
        if (selfSwapCandidates.has(String(payment.tx_hash || '').toLowerCase()) && payment.tx_hash) {
          continue // handled via selfSwapCandidates below
        }
        sentLoggedRest.push(payment)
      }
      for (const payment of selfSwapCandidates.values()) {
        const hash = String(payment.tx_hash).toLowerCase()
        const match = onchainSwaps.find(item => item.tx_hash?.toLowerCase() === hash)
        if (match) consumedSwapHashes.add(hash)
        loggedSwaps.push({
          ...payment,
          id: `swap-log-${payment.id}`,
          type: 'swap',
          swap: {
            tokenIn: payment.token,
            amountIn: Number(payment.amount),
            tokenOut: match?.swap?.tokenOut || (payment.token === 'USDC' ? 'EURC' : 'USDC'),
            amountOut: match?.swap?.amountOut ?? null,
          },
        })
      }

      const remainingOnchainSwaps = onchainSwaps.filter(item => !item.tx_hash || !consumedSwapHashes.has(item.tx_hash.toLowerCase()))
      const receivedOnchain = onchainRest.filter(payment => payment.type === 'received')
      const sentOnchain = onchainRest.filter(payment => payment.type === 'sent')
      const mergedReceived = mergePayments(receivedLogged, receivedOnchain)
      const mergedSent = mergePayments([...swapRows, ...sentLoggedRest, ...loggedSwaps], [...sentOnchain, ...remainingOnchainSwaps])
      // Earn events are first-class rows from our own ledger (never heuristics).
      const earnRows: LedgerPayment[] = earnEvents.map(event => {
        const token = String(event.token).toUpperCase()
        const shareSymbol = token === 'USDC' ? 'alvUSDC' : 'alvEURC'
        return {
          id: `earn-${event.id}`,
          link_id: '',
          payer_address: cavoWalletAddress,
          recipient_address: event.destination_address || cavoWalletAddress,
          source_chain: ARC_TESTNET_CHAIN,
          destination_chain: event.destination_chain || ARC_TESTNET_CHAIN,
          tx_hash: event.bridge_tx_hash || event.tx_hash || '',
          amount: Number(event.amount) || 0,
          token,
          created_at: event.created_at,
          type: 'earn' as const,
          earn: {
            kind: event.kind,
            token,
            amount: Number(event.amount) || 0,
            shares: Number(event.shares) || 0,
            shareSymbol,
          },
        }
      })
      setReceivedPayments(mergedReceived)
      setSentPayments(mergedSent)
      setEarnPayments(earnRows)
      saveLedgerCache(cavoWalletAddress, mergedReceived, mergedSent, earnRows)
      ledgerHydrated.current = true

      const counterpartyAddresses = [...receivedLogged, ...sentLogged, ...onchainRows].flatMap(payment => [
        payment.payer_address,
        payment.recipient_address,
        payment.payment_links?.creator_address,
      ]).filter(Boolean) as string[]
      refreshProfileMap(counterpartyAddresses)
    } catch (error) {
      console.warn('Ledger refresh failed:', error)
    } finally {
      ledgerRefreshInFlight.current = false
      setLedgerLoading(false)
      setLedgerSyncing(false)
    }
  }

  const refreshCavoPinStatus = async () => {
    if (!activeUserKey) return
    try {
      const status = await getCavoPinStatus(activeUserKey)
      setHasCavoPin(status.hasPin)
    } catch (error) {
      console.warn('Cavo PIN status failed:', error)
    }
  }

  useEffect(() => {
    if (!activeUserKey) return
    refreshWallet()
    refreshCavoPinStatus()
  }, [activeUserKey])

  useEffect(() => {
    if (!cavoWalletAddress) return
    loadCachedBalances(cavoWalletAddress)
    // Paint instantly from the last snapshot, then sync quietly in the background.
    loadCachedLedger(cavoWalletAddress)
    refreshBalances()
    refreshLedger({ force: true })
    refreshEarn()
    if (refreshTimer.current) window.clearInterval(refreshTimer.current)
    // Slow background cadence: balances + ledger revalidate at most every 60s
    // (refreshLedger itself enforces a 15s minimum gap and skips overlaps).
    refreshTimer.current = window.setInterval(() => {
      refreshBalances()
      refreshLedger()
    }, 60000)
    const syncOnVisible = () => {
      if (document.visibilityState !== 'visible') return
      refreshBalances()
      refreshLedger()
    }
    document.addEventListener('visibilitychange', syncOnVisible)
    window.addEventListener('focus', syncOnVisible)
    return () => {
      if (refreshTimer.current) window.clearInterval(refreshTimer.current)
      document.removeEventListener('visibilitychange', syncOnVisible)
      window.removeEventListener('focus', syncOnVisible)
    }
  }, [cavoWalletAddress])

  useEffect(() => {
    if (!isSwapModalOpen || swapStep !== 'details' || !activeUserKey || !cavoWalletAddress) return
    const amount = Number(swapAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setSwapQuote(null)
      setQuoteError(null)
      return
    }

    const quoteSeq = ++quoteRequestSeq.current
    setQuoteLoading(true)
    const timer = window.setTimeout(() => {
      getSwapQuote({
        userKey: activeUserKey,
        walletAddress: cavoWalletAddress,
        tokenIn: swapTokenIn,
        tokenOut: swapTokenIn === 'USDC' ? 'EURC' : 'USDC',
        amountIn: swapAmount,
      })
        .then(quote => {
          if (quoteRequestSeq.current === quoteSeq) setSwapQuote(quote)
        })
        .catch((error: any) => {
          if (quoteRequestSeq.current !== quoteSeq) return
          setSwapQuote(null)
          setQuoteError(error.message || 'Failed to fetch swap quote')
        })
        .finally(() => {
          if (quoteRequestSeq.current === quoteSeq) setQuoteLoading(false)
        })
    }, 600)

    return () => window.clearTimeout(timer)
  }, [isSwapModalOpen, swapStep, swapAmount, swapTokenIn, activeUserKey, cavoWalletAddress])

  const handleQrScan = async (value: string) => {
    setIsScanQrOpen(false)
    const trimmed = value.trim()
    if (!trimmed) return

    try {
      const parsed = new URL(trimmed, window.location.origin)
      if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/u/')) {
        const username = decodeURIComponent(parsed.pathname.replace(/^\/u\//, '')).replace(/^@/, '').trim()
        if (!username) return
        const scannedProfile = await getProfile(username)
        setScannedRecipient(scannedProfile)
        openSend(`@${scannedProfile.username}`, scannedProfile)
        return
      }
      if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/pay/')) {
        navigate(`${parsed.pathname}${parsed.search}${parsed.hash}`)
        return
      }
      window.location.href = trimmed
    } catch {
      setSendDest(trimmed)
      openSend(trimmed)
    }
  }

  useEffect(() => {
    if (!favoritesKey) return
    try {
      const stored = JSON.parse(localStorage.getItem(favoritesKey) || '[]')
      setFavorites(Array.isArray(stored) ? stored : [])
    } catch {
      setFavorites([])
    }
  }, [favoritesKey])

  useEffect(() => {
    if (!profile || hasCavoPin !== false || showClaimModal) return
    setCavoPin('')
    setConfirmPin('')
    setSecurityAnswerOne('')
    setSecurityAnswerTwo('')
    setPinSetupError(null)
    setShowPinSetupModal(true)
  }, [profile, hasCavoPin, showClaimModal])

  const saveFavorites = (nextFavorites: ContactEntry[]) => {
    setFavorites(nextFavorites)
    if (favoritesKey) localStorage.setItem(favoritesKey, JSON.stringify(nextFavorites))
  }

  const toggleFavorite = (contactAddress: string) => {
    const key = normalizeAddress(contactAddress)
    if (!key) return
    const existing = favorites.some(item => normalizeAddress(item.address) === key)
    if (existing) {
      saveFavorites(favorites.filter(item => normalizeAddress(item.address) !== key))
      return
    }
    saveFavorites([
      ...favorites,
      {
        address: contactAddress,
        username: profileMap[key]?.username,
        avatarUrl: profileMap[key]?.avatar_url,
        lastPayment: new Date().toISOString(),
        token: '',
        type: 'favorite',
      },
    ])
  }

  const toContactEntries = (payments: LedgerPayment[], addressSelector: (payment: LedgerPayment) => string | undefined | null) => {
    const byAddress = new Map<string, ContactEntry>()
    for (const payment of payments) {
      const contactAddress = addressSelector(payment)
      const key = normalizeAddress(contactAddress)
      if (!key || key === normalizeAddress(cavoWalletAddress)) continue
      const existing = byAddress.get(key)
      if (existing && new Date(existing.lastPayment) >= new Date(payment.created_at)) continue
      byAddress.set(key, {
        address: contactAddress || key,
        username: profileMap[key]?.username,
        avatarUrl: profileMap[key]?.avatar_url,
        lastPayment: payment.created_at,
        token: payment.token,
        type: payment.type === 'received' ? 'received' : 'sent',
      })
    }
    return Array.from(byAddress.values()).sort((a, b) => new Date(b.lastPayment).getTime() - new Date(a.lastPayment).getTime())
  }

  const recentSentContacts = useMemo(() => toContactEntries(sentPayments, payment =>
    payment.recipient_address || payment.payment_links?.creator_address,
  ), [sentPayments, profileMap, cavoWalletAddress])

  const receivedFromContacts = useMemo(() => toContactEntries(receivedPayments, payment =>
    payment.payer_address,
  ), [receivedPayments, profileMap, cavoWalletAddress])

  const profileUrl = profile ? `${window.location.origin}/u/${profile.username}` : ''

  const createLink = async () => {
    const targetAddress = form.recipient.trim() || cavoWalletAddress
    if (!targetAddress) {
      setCreateError('Cavo wallet is still loading')
      return
    }
    setCreateLoading(true)
    setCreateError(null)
    setGeneratedLink(null)
    try {
      let creatorAddress = targetAddress
      if (!creatorAddress.startsWith('0x')) {
        const username = creatorAddress.replace('@', '').toLowerCase()
        const targetProfile = await getProfile(username)
        creatorAddress = targetProfile.wallet_address
      }
      const link = await createPaymentLink({
        creatorAddress,
        amount: form.amount,
        token: form.token,
        note: form.note,
      })
      setGeneratedLink(link.linkUrl)
    } catch (error: any) {
      setCreateError(error.message || 'Failed to create payment link')
    } finally {
      setCreateLoading(false)
    }
  }

  const claimUsername = async () => {
    if (!claimName || !cavoWalletAddress || !activeUserKey) return
    setClaimLoading(true)
    setClaimErr(null)
    try {
      const nextProfile = await claimProfile({ username: claimName, walletAddress: activeUserKey })
      setProfile(nextProfile)
      setProfileMap(previous => ({
        ...previous,
        [normalizeAddress(activeUserKey)]: nextProfile,
        [normalizeAddress(cavoWalletAddress)]: nextProfile,
      }))
      setShowClaimModal(false)
      if (hasCavoPin === false) {
        setCavoPin('')
        setConfirmPin('')
        setSecurityAnswerOne('')
        setSecurityAnswerTwo('')
        setPinSetupError(null)
        setShowPinSetupModal(true)
      }
    } catch (error: any) {
      setClaimErr(error.message || 'Failed to claim username')
    } finally {
      setClaimLoading(false)
    }
  }

  const saveProfileToMaps = (nextProfile: Profile) => {
    setProfile(nextProfile)
    setProfileMap(previous => ({
      ...previous,
      [normalizeAddress(activeUserKey)]: nextProfile,
      [normalizeAddress(cavoWalletAddress)]: nextProfile,
      [normalizeAddress(nextProfile.owner_address)]: nextProfile,
      [normalizeAddress(nextProfile.wallet_address)]: nextProfile,
    }))
  }

  const selectAvatarFile = () => {
    if (!profile || avatarUploading) return
    avatarInputRef.current?.click()
  }

  const handleAvatarFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !profile) return

    setAvatarUploading(true)
    setAvatarError(null)
    try {
      const avatarUrl = await resizeAvatarFile(file)
      const nextProfile = await updateProfileAvatar(profile.username, avatarUrl)
      saveProfileToMaps(nextProfile)
    } catch (error: any) {
      setAvatarError(error.message || 'Failed to update profile picture')
    } finally {
      setAvatarUploading(false)
    }
  }

  const createPaymentPin = async () => {
    if (!activeUserKey) return
    if (cavoPin.length !== 4 || confirmPin.length !== 4) {
      setPinSetupError('Enter and confirm your 4-digit Payment PIN')
      return
    }
    if (cavoPin !== confirmPin) {
      setPinSetupError('Payment PINs do not match')
      return
    }
    if (!securityAnswerOne.trim() || !securityAnswerTwo.trim()) {
      setPinSetupError('Answer both security questions')
      return
    }

    setPinSetupLoading(true)
    setPinSetupError(null)
    try {
      await setupCavoPin({
        userKey: activeUserKey,
        pin: cavoPin,
        recoveryAnswers: [securityAnswerOne, securityAnswerTwo],
      })
      setHasCavoPin(true)
      setShowPinSetupModal(false)
      setCavoPin('')
      setConfirmPin('')
      setSecurityAnswerOne('')
      setSecurityAnswerTwo('')
    } catch (error: any) {
      setPinSetupError(error.message || 'Failed to create Payment PIN')
    } finally {
      setPinSetupLoading(false)
    }
  }

  const openSend = (target?: string, scannedProfile?: Profile | null) => {
    setSendDest(target || '')
    setScannedRecipient(scannedProfile || null)
    setSendAmount('')
    setSendToken('USDC')
    setDestinationChain(ARC_TESTNET_CHAIN)
    setSendStep('details')
    setPendingSend(null)
    setCavoPin('')
    setConfirmPin('')
    setSecurityAnswerOne('')
    setSecurityAnswerTwo('')
    setBridgeStage('idle')
    setSendError(null)
    setIsSendModalOpen(true)
  }

  const closeSend = () => {
    if (isSending) return
    setIsSendModalOpen(false)
    setSendError(null)
    setScannedRecipient(null)
  }

  const prepareSend = async () => {
    if (!sendDest.trim() || !sendAmount || !circleWallet?.walletId || !cavoWalletAddress) return
    setSendError(null)
    setIsSending(true)
    try {
      let recipientAddress = sendDest.trim()
      let isUsername = false
      if (!recipientAddress.startsWith('0x')) {
        const username = recipientAddress.replace('@', '').toLowerCase()
        const targetProfile = await getProfile(username)
        recipientAddress = targetProfile.wallet_address
        isUsername = true
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
        throw new Error('Recipient must be a valid wallet address or Cavo username')
      }
      setPendingSend({
        recipientAddress,
        amount: sendAmount,
        // Send is Cavo-to-Cavo on Arc. Cross-chain moves go via Withdraw.
        destinationChain: ARC_TESTNET_CHAIN,
        token: sendToken,
        isUsername,
      })
      setSendStep('pin')
    } catch (error: any) {
      setSendError(error.message || 'Failed to prepare payment')
    } finally {
      setIsSending(false)
    }
  }

  const addPendingSentPayment = (send: PendingSend, trackingId?: string) => {
    const id = trackingId ? `pending-${trackingId}` : `pending-${Date.now()}`
    const pendingPayment: LedgerPayment = {
      id,
      link_id: '',
      payer_address: cavoWalletAddress,
      recipient_address: send.recipientAddress,
      source_chain: ARC_TESTNET_CHAIN,
      destination_chain: send.destinationChain,
      tx_hash: '',
      amount: Number(send.amount),
      token: send.token,
      created_at: new Date().toISOString(),
      type: 'sent',
    }
    setSentPayments(previous => mergePayments([pendingPayment], previous))
    return id
  }

  const removePendingSentPayment = (pendingId?: string) => {
    if (!pendingId) return
    setSentPayments(previous => previous.filter(payment => payment.id !== pendingId))
  }

  const findRecentOutgoingTransferHash = async (send: PendingSend, startedAt: number) => {
    const token = TOKENS[send.token]
    const expectedAmount = parseUnits(send.amount, token.decimals)
    const transfers = await getTokenTransfers(cavoWalletAddress, token.address).catch(() => [])
    const match = transfers.find((transfer: any) => {
      const from = String(transfer.from || '').toLowerCase()
      const value = BigInt(transfer.value || 0)
      const timestamp = Number(transfer.timeStamp || 0) * 1000
      return from === cavoWalletAddress.toLowerCase()
        && value === expectedAmount
        && timestamp >= startedAt - 30000
        && /^0x[a-fA-F0-9]{64}$/.test(String(transfer.hash || ''))
    })
    return match?.hash as string | undefined
  }

  const waitForTrackedTransaction = async (trackingId: string, send: PendingSend, startedAt: number) => {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await wait(attempt === 0 ? 1200 : 2500)
      const status = await getWalletTransactionStatus(trackingId)
      const txHash = status.txHash || getTxHash(status)
      if (txHash) return txHash
      const arcHash = await findRecentOutgoingTransferHash(send, startedAt)
      if (arcHash) return arcHash
      refreshBalances()
      refreshLedger()
    }
    return undefined
  }

  const completeCavoPinSend = async () => {
    if (!pendingSend || !circleWallet?.walletId || !cavoWalletAddress || !activeUserKey) return
    if (!hasCavoPin && cavoPin !== confirmPin) {
      setSendError('Payment PINs do not match')
      return
    }
    setIsSending(true)
    setSendError(null)
    setSendStep('processing')
    setBridgeStage('preparing')
    try {
      if (!hasCavoPin) {
        if (!securityAnswerOne.trim() || !securityAnswerTwo.trim()) {
          throw new Error('Answer both security questions before creating your Payment PIN')
        }
        await setupCavoPin({
          userKey: activeUserKey,
          pin: cavoPin,
          recoveryAnswers: [securityAnswerOne, securityAnswerTwo],
        })
        setHasCavoPin(true)
      }

      const approval = await approveCavoPinTransaction({
        userKey: activeUserKey,
        pin: cavoPin,
        walletAddress: cavoWalletAddress,
        walletId: circleWallet.walletId,
        destinationAddress: pendingSend.recipientAddress,
        destinationChain: pendingSend.destinationChain,
        amount: pendingSend.amount,
        token: pendingSend.token,
      })

      setBridgeStage('submitting')
      const submittedAt = Date.now()
      const result = pendingSend.destinationChain === ARC_TESTNET_CHAIN
        ? await sendDeveloperControlledTransfer({
            userKey: activeUserKey,
            walletAddress: cavoWalletAddress,
            walletId: circleWallet.walletId,
            destinationAddress: pendingSend.recipientAddress,
            destinationChain: pendingSend.destinationChain,
            amount: pendingSend.amount,
            token: pendingSend.token,
            approvalId: approval.approvalId,
          })
        : await bridgeDeveloperControlledTransfer({
            userKey: activeUserKey,
            walletAddress: cavoWalletAddress,
            walletId: circleWallet.walletId,
            destinationAddress: pendingSend.recipientAddress,
            destinationChain: pendingSend.destinationChain,
            amount: pendingSend.amount,
            approvalId: approval.approvalId,
          })

      setBridgeStage('confirming')
      let txHash = getTxHash(result)
      const trackingId = result.trackingId
      const pendingPaymentId = !txHash ? addPendingSentPayment(pendingSend, trackingId) : undefined

      if (!txHash && trackingId) {
        txHash = await waitForTrackedTransaction(trackingId, pendingSend, submittedAt)
      }

      if (txHash) {
        setBridgeStage('recording')
        removePendingSentPayment(pendingPaymentId)
        await logPayment({
          payerAddress: cavoWalletAddress,
          recipientAddress: pendingSend.recipientAddress,
          sourceChain: ARC_TESTNET_CHAIN,
          destinationChain: pendingSend.destinationChain,
          txHash,
          amount: pendingSend.amount,
          token: pendingSend.token,
        })
      } else {
        console.warn('Payment submitted but the backend has not returned a transaction hash yet:', result)
      }

      setBridgeStage('complete')
      setSendSuccess({
        amount: pendingSend.amount,
        token: pendingSend.token,
        recipient: pendingSend.isUsername ? sendDest : pendingSend.recipientAddress,
        txHash,
      })
      setIsSendModalOpen(false)
      await wait(2500)
      refreshBalances()
      refreshLedger({ force: true })
    } catch (error: any) {
      setBridgeStage('error')
      setSendStep('pin')
      setSendError(error.message || 'Payment failed')
    } finally {
      setIsSending(false)
      setCavoPin('')
    }
  }

  const openWithdraw = () => {
    setWithdrawAddress('')
    setWithdrawChain(ARC_TESTNET_CHAIN)
    setWithdrawAmount('')
    setWithdrawError(null)
    setWithdrawStep('details')
    setCavoPin('')
    setConfirmPin('')
    setSecurityAnswerOne('')
    setSecurityAnswerTwo('')
    setIsWithdrawModalOpen(true)
  }

  const closeWithdraw = () => {
    if (isWithdrawing) return
    setIsWithdrawModalOpen(false)
    setWithdrawError(null)
  }

  const prepareWithdraw = () => {
    if (!isValidWithdrawAddress(withdrawChain, withdrawAddress)) {
      setWithdrawError('Enter a valid destination address for the selected chain')
      return
    }
    setWithdrawError(null)
    setWithdrawStep('pin')
  }

  const completeWithdraw = async () => {
    if (!circleWallet?.walletId || !cavoWalletAddress || !activeUserKey) return
    if (!hasCavoPin && cavoPin !== confirmPin) {
      setWithdrawError('Payment PINs do not match')
      return
    }
    const amountNumber = Number(withdrawAmount)
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setWithdrawError('Enter a valid amount')
      return
    }
    setIsWithdrawing(true)
    setWithdrawError(null)
    setWithdrawStep('processing')
    try {
      if (!hasCavoPin) {
        if (!securityAnswerOne.trim() || !securityAnswerTwo.trim()) {
          throw new Error('Answer both security questions before creating your Payment PIN')
        }
        await setupCavoPin({
          userKey: activeUserKey,
          pin: cavoPin,
          recoveryAnswers: [securityAnswerOne, securityAnswerTwo],
        })
        setHasCavoPin(true)
      }

      const approval = await approveCavoPinTransaction({
        userKey: activeUserKey,
        pin: cavoPin,
        walletAddress: cavoWalletAddress,
        walletId: circleWallet.walletId,
        destinationAddress: withdrawAddress.trim(),
        destinationChain: withdrawChain,
        amount: withdrawAmount,
        token: 'USDC',
        transactionType: 'send',
      })

      const submittedAt = Date.now()
      const transfer: PendingSend = {
        recipientAddress: withdrawAddress.trim(),
        amount: withdrawAmount,
        destinationChain: withdrawChain,
        token: 'USDC',
        isUsername: false,
      }
      const result = withdrawChain === ARC_TESTNET_CHAIN
        ? await sendDeveloperControlledTransfer({
            userKey: activeUserKey,
            walletAddress: cavoWalletAddress,
            walletId: circleWallet.walletId,
            destinationAddress: transfer.recipientAddress,
            destinationChain: withdrawChain,
            amount: withdrawAmount,
            token: 'USDC',
            approvalId: approval.approvalId,
          })
        : await bridgeDeveloperControlledTransfer({
            userKey: activeUserKey,
            walletAddress: cavoWalletAddress,
            walletId: circleWallet.walletId,
            destinationAddress: transfer.recipientAddress,
            destinationChain: withdrawChain,
            amount: withdrawAmount,
            approvalId: approval.approvalId,
          })

      let txHash = getTxHash(result)
      const trackingId = result.trackingId
      const pendingPaymentId = !txHash ? addPendingSentPayment(transfer, trackingId) : undefined
      if (!txHash && trackingId) {
        txHash = await waitForTrackedTransaction(trackingId, transfer, submittedAt)
      }
      if (txHash) {
        removePendingSentPayment(pendingPaymentId)
        await logPayment({
          payerAddress: cavoWalletAddress,
          recipientAddress: transfer.recipientAddress,
          sourceChain: ARC_TESTNET_CHAIN,
          destinationChain: withdrawChain,
          txHash,
          amount: withdrawAmount,
          token: 'USDC',
        })
      } else {
        console.warn('Withdrawal submitted but the backend has not returned a transaction hash yet:', result)
      }

      setWithdrawSuccess({
        amount: withdrawAmount,
        recipient: transfer.recipientAddress,
        chain: withdrawChain,
        txHash,
      })
      setIsWithdrawModalOpen(false)
      await wait(2500)
      refreshBalances()
      refreshLedger({ force: true })
    } catch (error: any) {
      setWithdrawStep('pin')
      setWithdrawError(error.message || 'Withdrawal failed')
    } finally {
      setIsWithdrawing(false)
      setCavoPin('')
    }
  }

  const openSwap = () => {
    setSwapAmount('')
    setSwapTokenIn('USDC')
    setSwapQuote(null)
    setQuoteError(null)
    setSwapError(null)
    setSwapStep('details')
    setCavoPin('')
    setConfirmPin('')
    setSecurityAnswerOne('')
    setSecurityAnswerTwo('')
    setIsSwapModalOpen(true)
  }

  const closeSwap = () => {
    if (isSwapping) return
    setIsSwapModalOpen(false)
    setSwapError(null)
  }

  const openEarn = (mode: EarnMode = 'deposit', token?: EarnToken) => {
    setEarnMode(mode)
    if (token) setEarnToken(token)
    setEarnAmount('')
    setEarnError(null)
    setEarnStep('details')
    setCavoPin('')
    setConfirmPin('')
    setSecurityAnswerOne('')
    setSecurityAnswerTwo('')
    setIsEarnModalOpen(true)
    refreshEarn()
  }

  const closeEarn = () => {
    if (isEarning) return
    setIsEarnModalOpen(false)
    setEarnError(null)
  }

  const prepareEarn = () => {
    setEarnError(null)
    setEarnStep('pin')
  }

  const refreshEarn = async (retried = false) => {
    if (!cavoWalletAddress) return
    setEarnVaultsLoading(true)
    try {
      const [vaults, positions] = await Promise.all([
        getEarnVaults(cavoWalletAddress).catch((): EarnVault[] => []),
        activeUserKey ? getEarnPositions(activeUserKey).catch((): EarnPosition[] => []) : Promise.resolve([] as EarnPosition[]),
      ])
      // One automatic retry: a single RPC blip shouldn't end in "unavailable".
      if (vaults.length === 0 && !retried) {
        await wait(3000)
        return refreshEarn(true)
      }
      setEarnVaults(vaults)
      setEarnPositions(positions)
    } catch (error) {
      console.warn('Earn refresh failed:', error)
    } finally {
      setEarnVaultsLoading(false)
    }
  }

  const completeEarn = async () => {
    if (!circleWallet?.walletId || !cavoWalletAddress || !activeUserKey) return
    if (!hasCavoPin && cavoPin !== confirmPin) {
      setEarnError('Payment PINs do not match')
      return
    }
    const amountNumber = Number(earnAmount)
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setEarnError('Enter a valid amount')
      return
    }
    const vault = earnVaults.find(item => item.token === earnToken)
    const shareSymbol = earnToken === 'USDC' ? 'alvUSDC' : 'alvEURC'
    setIsEarning(true)
    setEarnError(null)
    setEarnStep('processing')
    try {
      if (!hasCavoPin) {
        if (!securityAnswerOne.trim() || !securityAnswerTwo.trim()) {
          throw new Error('Answer both security questions before creating your Payment PIN')
        }
        await setupCavoPin({
          userKey: activeUserKey,
          pin: cavoPin,
          recoveryAnswers: [securityAnswerOne, securityAnswerTwo],
        })
        setHasCavoPin(true)
      }

      if (earnMode === 'deposit') {
        if (!vault) throw new Error('Vault data is still loading. Try again in a moment.')
        const approval = await approveCavoPinTransaction({
          userKey: activeUserKey,
          pin: cavoPin,
          walletAddress: cavoWalletAddress,
          walletId: circleWallet.walletId,
          destinationAddress: vault.vault,
          destinationChain: ARC_TESTNET_CHAIN,
          amount: earnAmount,
          token: earnToken,
          transactionType: 'earn',
        })
        const result = await depositEarn({
          userKey: activeUserKey,
          walletAddress: cavoWalletAddress,
          walletId: circleWallet.walletId,
          token: earnToken,
          amount: earnAmount,
          approvalId: approval.approvalId,
        })
        setIsEarnModalOpen(false)
        setEarnSuccess({
          mode: 'deposit',
          amount: String(result.amount),
          token: result.token,
          shares: String(result.shares),
          shareSymbol,
          txHash: result.txHash || undefined,
        })
      } else {
        if (!vault) throw new Error('Vault data is still loading. Try again in a moment.')
        const approval = await approveCavoPinTransaction({
          userKey: activeUserKey,
          pin: cavoPin,
          walletAddress: cavoWalletAddress,
          walletId: circleWallet.walletId,
          destinationAddress: vault.vault,
          destinationChain: ARC_TESTNET_CHAIN,
          amount: earnAmount,
          token: earnToken,
          transactionType: 'earn',
        })
        const result = await withdrawEarn({
          userKey: activeUserKey,
          walletAddress: cavoWalletAddress,
          walletId: circleWallet.walletId,
          token: earnToken,
          shares: earnAmount,
          approvalId: approval.approvalId,
          destinationChain: ARC_TESTNET_CHAIN,
          destinationAddress: cavoWalletAddress,
        })
        setIsEarnModalOpen(false)
        setEarnSuccess({
          mode: 'withdraw',
          amount: String(result.amount),
          token: result.token,
          shares: String(result.shares),
          shareSymbol,
          txHash: result.txHash || undefined,
          destinationChain: ARC_TESTNET_CHAIN,
          destinationLabel: undefined,
        })
      }
      await wait(1500)
      refreshBalances()
      refreshLedger({ force: true })
      refreshEarn()
    } catch (error: any) {
      setEarnStep('pin')
      setEarnError(error.message || (earnMode === 'deposit' ? 'Deposit failed' : 'Withdrawal failed'))
    } finally {
      setIsEarning(false)
      setCavoPin('')
    }
  }

  const prepareSwap = () => {
    if (!swapQuote) return
    setSwapError(null)
    setSwapStep('pin')
  }

  const completeSwap = async () => {
    if (!swapQuote || !circleWallet?.walletId || !cavoWalletAddress || !activeUserKey) return
    if (!hasCavoPin && cavoPin !== confirmPin) {
      setSwapError('Payment PINs do not match')
      return
    }
    const tokenOut = swapTokenIn === 'USDC' ? 'EURC' : 'USDC'
    setIsSwapping(true)
    setSwapError(null)
    setSwapStep('processing')
    try {
      if (!hasCavoPin) {
        if (!securityAnswerOne.trim() || !securityAnswerTwo.trim()) {
          throw new Error('Answer both security questions before creating your Payment PIN')
        }
        await setupCavoPin({
          userKey: activeUserKey,
          pin: cavoPin,
          recoveryAnswers: [securityAnswerOne, securityAnswerTwo],
        })
        setHasCavoPin(true)
      }

      const approval = await approveCavoPinTransaction({
        userKey: activeUserKey,
        pin: cavoPin,
        walletAddress: cavoWalletAddress,
        walletId: circleWallet.walletId,
        destinationAddress: cavoWalletAddress,
        destinationChain: ARC_TESTNET_CHAIN,
        amount: swapQuote.amountIn,
        token: swapTokenIn,
        tokenOut,
        transactionType: 'swap',
      })

      const result = await executeSwap({
        userKey: activeUserKey,
        walletAddress: cavoWalletAddress,
        walletId: circleWallet.walletId,
        tokenIn: swapTokenIn,
        tokenOut,
        amountIn: swapQuote.amountIn,
        minOut: swapQuote.minOut,
        approvalId: approval.approvalId,
      })

      setIsSwapModalOpen(false)
      setSwapSuccess({
        amountIn: swapQuote.amountIn,
        tokenIn: swapTokenIn,
        amountOut: result.amountOut || swapQuote.estimatedOutput,
        tokenOut,
        txHash: result.txHash || undefined,
      })
      // Record the swap in our own ledger so it shows in history even when
      // the Arcscan transfer API is rate-limited. Sends do the same via logPayment.
      if (result.txHash) {
        try {
          await logPayment({
            payerAddress: cavoWalletAddress,
            recipientAddress: cavoWalletAddress,
            sourceChain: ARC_TESTNET_CHAIN,
            destinationChain: ARC_TESTNET_CHAIN,
            txHash: result.txHash,
            amount: swapQuote.amountIn,
            token: swapTokenIn,
          })
        } catch (logError) {
          console.warn('Swap executed but ledger logging failed:', logError)
        }
      }
      await wait(1500)
      refreshBalances()
      refreshLedger({ force: true })
    } catch (error: any) {
      setSwapStep('pin')
      setSwapError(error.message || 'Swap failed')
    } finally {
      setIsSwapping(false)
      setCavoPin('')
    }
  }

  const getCounterpartyLabel = (payment: LedgerPayment) => {
    if (payment.type === 'swap') {
      const legs = payment.swap
      return legs ? `Swap ${legs.tokenIn} → ${legs.tokenOut}` : 'Swap'
    }
    if (payment.type === 'earn') {
      const legs = payment.earn
      return legs
        ? legs.kind === 'deposit' ? `Earn · ${legs.shareSymbol}` : `Earn · ${legs.token}`
        : 'Earn'
    }
    const isReceived = payment.type === 'received'
    const value = isReceived
      ? payment.payer_address
      : payment.recipient_address || payment.payment_links?.creator_address
    if (value && normalizeAddress(value) === normalizeAddress(cavoWalletAddress)) {
      return `${isReceived ? 'From' : 'To'}: Your wallet`
    }
    return `${isReceived ? 'From' : 'To'}: ${formatLedgerAddress(value, profileMap)}`
  }

  const renderTransactionReceipt = () => {
    if (!selectedPayment) return null

    const isReceived = selectedPayment.type === 'received'
    const isSwap = selectedPayment.type === 'swap'
    const isEarn = selectedPayment.type === 'earn'
    const swapLegs = selectedPayment.swap
    const earnLegs = selectedPayment.earn
    const status = selectedPayment.tx_hash ? 'Completed' : 'Pending'
    const counterpartyAddress = isReceived
      ? selectedPayment.payer_address
      : selectedPayment.recipient_address || selectedPayment.payment_links?.creator_address
    const sourceChain = getDestinationChainLabel(selectedPayment.source_chain || ARC_TESTNET_CHAIN)
    const destinationChain = getDestinationChainLabel(selectedPayment.destination_chain || ARC_TESTNET_CHAIN)
    const explorerUrl = paymentExplorerUrl(selectedPayment)
    const amountPrefix = isReceived ? '+' : '-'
    const headline = isSwap ? 'Swap Receipt' : isEarn ? 'Earn Receipt' : 'Transaction Receipt'
    const directionLabel =
      selectedPayment.type === 'swap' ? 'Swap'
      : selectedPayment.type === 'earn' ? 'Earn'
      : isReceived ? 'Received' : 'Sent'
    const subline = isSwap
      ? `Stablecoin conversion${swapLegs ? ` · ${swapLegs.tokenIn} → ${swapLegs.tokenOut}` : ''} on Arc`
      : isEarn && earnLegs
        ? earnLegs.kind === 'deposit'
          ? `Vault deposit · ${earnLegs.token} → ${earnLegs.shareSymbol}`
          : `Vault withdrawal · ${earnLegs.shareSymbol} → ${earnLegs.token}`
      : isReceived ? 'Incoming stablecoin payment' : 'Outgoing stablecoin payment'

    return (
      <div className="wc-modal" onClick={() => setSelectedPayment(null)}>
        <div className="card glass receipt-card" onClick={event => event.stopPropagation()}>
          <div className="receipt-header">
            <div>
              <span className={`receipt-status ${selectedPayment.tx_hash ? 'success' : 'pending'}`}>{status}</span>
              <h2>{headline}</h2>
              <p>{subline}</p>
            </div>
            <button className="receipt-close icon-btn" onClick={() => setSelectedPayment(null)} aria-label="Close receipt">
              <X size={20} />
            </button>
          </div>

          {isSwap && swapLegs ? (
            <div className="receipt-amount outgoing">
              <span>Swapped</span>
              <strong>-{swapLegs.amountIn} {swapLegs.tokenIn} → +{swapLegs.amountOut ?? '…'} {swapLegs.tokenOut}</strong>
            </div>
          ) : isEarn && earnLegs ? (
            <div className="receipt-amount outgoing">
              <span>{earnLegs.kind === 'deposit' ? 'Deposited' : 'Withdrawn'}</span>
              <strong>
                {earnLegs.kind === 'deposit'
                  ? <>-{earnLegs.amount} {earnLegs.token} → +{earnLegs.shares} {earnLegs.shareSymbol}</>
                  : <>+{earnLegs.amount} {earnLegs.token} ← {earnLegs.shares} {earnLegs.shareSymbol}</>}
              </strong>
            </div>
          ) : (
            <div className={`receipt-amount ${isReceived ? 'incoming' : 'outgoing'}`}>
              <span>{isReceived ? 'Received' : 'Sent'}</span>
              <strong>{amountPrefix}{selectedPayment.amount} {selectedPayment.token}</strong>
            </div>
          )}

          <div className="receipt-section">
            <div className="receipt-row"><span>Direction</span><strong>{directionLabel}</strong></div>
            {isSwap && swapLegs ? (
              <>
                <div className="receipt-row"><span>You swapped</span><strong>-{swapLegs.amountIn} {swapLegs.tokenIn}</strong></div>
                <div className="receipt-row"><span>You received</span><strong>+{swapLegs.amountOut ?? '…'} {swapLegs.tokenOut}</strong></div>
              </>
            ) : isEarn && earnLegs ? (
              <>
                {earnLegs.kind === 'deposit' ? (
                  <>
                    <div className="receipt-row"><span>You deposited</span><strong>-{earnLegs.amount} {earnLegs.token}</strong></div>
                    <div className="receipt-row"><span>Shares received</span><strong>+{earnLegs.shares} {earnLegs.shareSymbol}</strong></div>
                  </>
                ) : (
                  <>
                    <div className="receipt-row"><span>Shares burned</span><strong>{earnLegs.shares} {earnLegs.shareSymbol}</strong></div>
                    <div className="receipt-row"><span>You received</span><strong>+{earnLegs.amount} {earnLegs.token}</strong></div>
                  </>
                )}
              </>
            ) : (
              <div className="receipt-row"><span>{isReceived ? 'From' : 'To'}</span><strong>{
                counterpartyAddress && normalizeAddress(counterpartyAddress) === normalizeAddress(cavoWalletAddress)
                  ? 'Your wallet'
                  : formatLedgerAddress(counterpartyAddress, profileMap)
              }</strong></div>
            )}
            <div className="receipt-row"><span>Your Cavo wallet</span><strong>{shorten(cavoWalletAddress)}</strong></div>
            <div className="receipt-row"><span>Date</span><strong>{fmtDate(selectedPayment.created_at)}</strong></div>
          </div>

          <div className="receipt-section">
            {isSwap && swapLegs ? (
              <div className="receipt-row"><span>Pair</span><strong>{swapLegs.tokenIn} → {swapLegs.tokenOut}</strong></div>
            ) : isEarn && earnLegs ? (
              <div className="receipt-row"><span>Vault</span><strong>{earnLegs.shareSymbol} · ArcLend</strong></div>
            ) : (
              <div className="receipt-row"><span>Asset</span><strong>{selectedPayment.token}</strong></div>
            )}
            <div className="receipt-row"><span>Source network</span><strong>{sourceChain}</strong></div>
            <div className="receipt-row"><span>Settlement network</span><strong>{destinationChain}</strong></div>
            {selectedPayment.link_id && <div className="receipt-row"><span>Payment link ID</span><strong>{selectedPayment.link_id}</strong></div>}
            {selectedPayment.payment_links?.note && <div className="receipt-row"><span>Note</span><strong>{selectedPayment.payment_links.note}</strong></div>}
          </div>

          <div className="receipt-hash-box">
            <span>Transaction hash</span>
            <div>
              <code>{selectedPayment.tx_hash || 'Waiting for confirmation'}</code>
              {selectedPayment.tx_hash && <CopyButton text={selectedPayment.tx_hash} />}
            </div>
          </div>

          <div className="receipt-actions">
            {selectedPayment.tx_hash ? (
              <a className="btn btn-primary btn-full" href={explorerUrl} target="_blank" rel="noopener noreferrer">
                View on Explorer
              </a>
            ) : (
              <button className="btn btn-secondary btn-full" disabled>Explorer available after confirmation</button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!isLoggedIn) {
    return (
      <>
        <Navbar />
        <div className="secure-screen">
          <div className="secure-card card glass">
            <h1>Secure</h1>
            <h2>Login to Cavo</h2>
            <p>Access your Cavo wallet, payment links, and transaction history.</p>
            <WalletButton />
          </div>
        </div>
      </>
    )
  }

  const renderSidebar = () => (
    <aside className="dashboard-sidebar">
      <button className={`side-link ${section === 'dashboard' ? 'active' : ''}`} onClick={() => setSection('dashboard')}>
        <Shield size={18} /> Dashboard
      </button>
      <button className={`side-link ${section === 'history' ? 'active' : ''}`} onClick={() => setSection('history')}>
        <RefreshCw size={18} /> History
      </button>
      <button className={`side-link ${section === 'contacts' ? 'active' : ''}`} onClick={() => setSection('contacts')}>
        <Users size={18} /> Contacts
      </button>
      <button className={`side-link ${section === 'links' ? 'active' : ''}`} onClick={() => setSection('links')}>
        <LinkIcon size={18} /> Links
      </button>
    </aside>
  )

  return (
    <>
      <Navbar username={profile?.username} />
      <main className="dashboard-layout">
        {renderSidebar()}
        <section className="dashboard-main">
          {section === 'dashboard' && (
            <>
              <div className="dashboard-hero">
                <button
                  type="button"
                  className={`avatar-ring avatar-upload-button ${avatarUploading ? 'is-uploading' : ''}`}
                  onClick={selectAvatarFile}
                  title={profile ? 'Change profile picture' : 'Claim a username first'}
                  disabled={!profile || avatarUploading}
                >
                  {profile?.avatar_url ? (
                    <img src={profile.avatar_url} alt={`${profile.username} profile`} />
                  ) : (
                    profile?.username?.[0]?.toUpperCase() || loginLabel?.[0]?.toUpperCase() || 'P'
                  )}
                </button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="visually-hidden"
                  onChange={handleAvatarFileChange}
                />
                <div>
                  <h1>Dashboard</h1>
                  {profile && <div className="profile-pill">@{profile.username}</div>}
                  {walletLoading && <p className="muted-small">Creating your Cavo wallet...</p>}
                  {walletError && <p style={{ color: 'var(--red)', fontSize: 13 }}>{walletError}</p>}
                  {avatarError && <p style={{ color: 'var(--red)', fontSize: 13 }}>{avatarError}</p>}
                </div>
              </div>

              <div className="dashboard-grid-top">
                <BalanceCard
                  walletAddress={cavoWalletAddress}
                  usdcDisplay={usdcDisplay}
                  eurcDisplay={eurcDisplay}
                  syncing={balanceLoading && !!cavoWalletAddress}
                  shortenAddress={shorten}
                />
                <QuickActions
                  profile={profile}
                  disabled={!cavoWalletAddress}
                  onSend={() => openSend()}
                  onSwap={openSwap}
                  onEarn={() => openEarn()}
                  onWithdraw={() => openWithdraw()}
                  onReceive={() => setIsReceiveModalOpen(true)}
                  onScanQr={() => setIsScanQrOpen(true)}
                />
              </div>

              <EarnSection
                vaults={earnVaults}
                positions={earnPositions}
                loading={earnVaultsLoading}
                onDeposit={(token) => openEarn('deposit', token)}
                onWithdraw={(token) => openEarn('withdraw', token)}
              />

              <TransactionList
                activeTab={miniTab}
                loading={ledgerLoading}
                syncing={ledgerSyncing}
                payments={miniPayments}
                receivedCount={receivedPayments.length}
                sentCount={sentOnlyPayments.length}
                swapCount={swapOnlyPayments.length}
                earnCount={earnPayments.length}
                visibleCount={4}
                showViewAll
                onTabChange={setMiniTab}
                onSelectPayment={setSelectedPayment}
                onViewAll={() => setSection('history')}
                formatDate={fmtDate}
                getCounterpartyLabel={getCounterpartyLabel}
                getExplorerUrl={paymentExplorerUrl}
              />
            </>
          )}

          {section === 'history' && (
            <>
              <div className="page-heading">
                <h1>Transaction History</h1>
                <p>View and filter incoming payments, outgoing payments, swaps and earn activity.</p>
              </div>
              <TransactionList
                activeTab={ledgerTab}
                loading={ledgerLoading}
                syncing={ledgerSyncing}
                payments={allPayments}
                receivedCount={receivedPayments.length}
                sentCount={sentOnlyPayments.length}
                swapCount={swapOnlyPayments.length}
                earnCount={earnPayments.length}
                visibleCount={historyVisibleCount}
                onTabChange={(tab) => {
                  setLedgerTab(tab)
                  setHistoryVisibleCount(8)
                }}
                onSelectPayment={setSelectedPayment}
                formatDate={fmtDate}
                getCounterpartyLabel={getCounterpartyLabel}
                getExplorerUrl={paymentExplorerUrl}
              />
              {allPayments.length > historyVisibleCount && (
                <button className="btn btn-secondary btn-full" style={{ marginTop: 16 }} onClick={() => setHistoryVisibleCount(count => count + 8)}>
                  Load More
                </button>
              )}
            </>
          )}

          {section === 'contacts' && (
            <>
              <div className="page-heading">
                <h1>Contacts</h1>
                <p>Recently paid addresses, saved favorites, and people who paid you.</p>
              </div>
              <ContactsPanel
                activeTab={contactTab}
                favorites={favorites}
                recentSent={recentSentContacts}
                receivedFrom={receivedFromContacts}
                formatDate={fmtDate}
                isFavorite={(contactAddress) => favorites.some(item => normalizeAddress(item.address) === normalizeAddress(contactAddress))}
                onSend={openSend}
                onTabChange={setContactTab}
                onToggleFavorite={toggleFavorite}
                shortenAddress={shorten}
              />
            </>
          )}

          {section === 'links' && (
            <>
              <div className="page-heading">
                <h1>Links</h1>
                <p>Create and share Cavo payment links.</p>
              </div>
              <div className="card glass links-create-card">
                <div className="form-stack">
                  <div className="form-group">
                    <label className="form-label">Recipient address or username</label>
                    <input
                      className="form-input"
                      value={form.recipient}
                      onChange={event => setForm({ ...form, recipient: event.target.value })}
                      placeholder={cavoWalletAddress || '0x address or @username'}
                    />
                    <p className="muted-small">Leave blank to use your Cavo wallet.</p>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Amount</label>
                    <input
                      className="form-input"
                      value={form.amount}
                      onChange={event => setForm({ ...form, amount: event.target.value })}
                      placeholder="0.00"
                      type="number"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Token</label>
                    <select className="form-input" value={form.token} onChange={event => setForm({ ...form, token: event.target.value as SendToken })}>
                      <option value="USDC">USDC</option>
                      <option value="EURC">EURC</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Note</label>
                    <input
                      className="form-input"
                      value={form.note}
                      onChange={event => setForm({ ...form, note: event.target.value })}
                      placeholder="Optional note"
                    />
                  </div>
                  {createError && <div className="error-text">{createError}</div>}
                  <button className="btn btn-primary btn-full" onClick={createLink} disabled={createLoading || !cavoWalletAddress}>
                    {createLoading ? 'Creating...' : 'Create Payment Link'}
                  </button>
                  {generatedLink && (
                    <div className="link-box">
                      <span className="link-url">{generatedLink}</span>
                      <CopyButton text={generatedLink} />
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </main>

      {showClaimModal && cavoWalletAddress && (
        <div className="wc-modal">
          <div className="card glass wc-card">
            <h2 className="wc-title">Claim Your Username</h2>
            <p className="wc-sub">Create a permanent link to receive payments instantly into your Cavo wallet.</p>
            <p className="claim-modal-warning">
              Important: Your username cannot be changed once claimed. Choose carefully.
            </p>
            <div className="form-stack">
              <input
                className="form-input"
                placeholder="Username (e.g. alice)"
                value={claimName}
                onChange={event => setClaimName(event.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))}
              />
              {claimErr && <div className="error-text">{claimErr}</div>}
              <button className="btn btn-primary btn-full" onClick={claimUsername} disabled={claimLoading || !claimName}>
                {claimLoading ? 'Claiming...' : 'Claim Username'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPinSetupModal && profile && (
        <div className="wc-modal">
          <div className="card glass wc-card">
            <h2 className="wc-title">Create Payment PIN</h2>
            <p className="wc-sub">
              Create a 4-digit Payment PIN. Cavo will require this PIN before every in-app send.
            </p>
            <div className="form-stack">
              <PinDotsInput
                label="New Payment PIN"
                value={cavoPin}
                onChange={setCavoPin}
                disabled={pinSetupLoading}
              />
              <PinDotsInput
                label="Confirm Payment PIN"
                value={confirmPin}
                onChange={setConfirmPin}
                disabled={pinSetupLoading}
              />
              <div className="form-group">
                <label className="form-label">{CAVO_SECURITY_QUESTIONS[0]}</label>
                <input
                  className="form-input"
                  placeholder="Your answer"
                  value={securityAnswerOne}
                  disabled={pinSetupLoading}
                  onChange={event => setSecurityAnswerOne(event.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">{CAVO_SECURITY_QUESTIONS[1]}</label>
                <input
                  className="form-input"
                  placeholder="Your recovery answer"
                  value={securityAnswerTwo}
                  disabled={pinSetupLoading}
                  onChange={event => setSecurityAnswerTwo(event.target.value)}
                />
              </div>
              {pinSetupError && <div className="error-text">{pinSetupError}</div>}
              <button
                className="btn btn-primary btn-full"
                onClick={createPaymentPin}
                disabled={
                  pinSetupLoading
                  || cavoPin.length !== 4
                  || confirmPin.length !== 4
                  || !securityAnswerOne.trim()
                  || !securityAnswerTwo.trim()
                }
              >
                {pinSetupLoading ? 'Creating PIN...' : 'Create Payment PIN'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isSendModalOpen && (
        <SendPaymentModal
          arcChain={ARC_TESTNET_CHAIN}
          chains={DESTINATION_CHAINS}
          confirmPin={confirmPin}
          destinationChain={destinationChain}
          hasCavoPin={hasCavoPin}
          isSending={isSending}
          cavoPin={cavoPin}
          pendingSend={pendingSend}
          securityAnswerOne={securityAnswerOne}
          securityAnswerTwo={securityAnswerTwo}
          sendAmount={sendAmount}
          sendDest={sendDest}
          sendError={sendError}
          sendStep={sendStep}
          sendToken={sendToken}
          scannedRecipient={scannedRecipient}
          onAmountChange={setSendAmount}
          onBackToDetails={() => setSendStep('details')}
          onClose={closeSend}
          onConfirmPinChange={setConfirmPin}
          onDestinationChainChange={setDestinationChain}
          onCavoPinChange={setCavoPin}
          onRecipientChange={setSendDest}
          onSecurityAnswerOneChange={setSecurityAnswerOne}
          onSecurityAnswerTwoChange={setSecurityAnswerTwo}
          onSend={prepareSend}
          onSubmitPin={completeCavoPinSend}
          onTokenChange={(token) => {
            setSendToken(token)
            if (token === 'EURC') setDestinationChain(ARC_TESTNET_CHAIN)
          }}
          getChainLabel={getDestinationChainLabel}
          shortenAddress={shorten}
        />
      )}

      {isSwapModalOpen && (
        <SwapModal
          swapStep={swapStep}
          swapAmount={swapAmount}
          swapTokenIn={swapTokenIn}
          swapQuote={swapQuote}
          quoteLoading={quoteLoading}
          quoteError={quoteError}
          swapError={swapError}
          isSwapping={isSwapping}
          cavoPin={cavoPin}
          confirmPin={confirmPin}
          securityAnswerOne={securityAnswerOne}
          securityAnswerTwo={securityAnswerTwo}
          hasCavoPin={hasCavoPin}
          walletAddress={cavoWalletAddress}
          onAmountChange={setSwapAmount}
          onTokenInChange={(token) => {
            setSwapTokenIn(token)
            setSwapQuote(null)
            setQuoteError(null)
          }}
          onCavoPinChange={setCavoPin}
          onConfirmPinChange={setConfirmPin}
          onSecurityAnswerOneChange={setSecurityAnswerOne}
          onSecurityAnswerTwoChange={setSecurityAnswerTwo}
          onReview={prepareSwap}
          onSubmitPin={completeSwap}
          onBackToDetails={() => setSwapStep('details')}
          onClose={closeSwap}
          shortenAddress={shorten}
        />
      )}

      {isReceiveModalOpen && (
        <ReceiveModal
          claimError={claimErr}
          claimLoading={claimLoading}
          claimName={claimName}
          loginLabel={loginLabel}
          cavoWalletAddress={cavoWalletAddress}
          profile={profile}
          qrValue={profileUrl || cavoWalletAddress || window.location.origin}
          onClaim={claimUsername}
          onClaimNameChange={setClaimName}
          onClose={() => setIsReceiveModalOpen(false)}
        />
      )}

      {isWithdrawModalOpen && (
        <WithdrawModal
          withdrawStep={withdrawStep}
          withdrawAddress={withdrawAddress}
          withdrawChain={withdrawChain}
          withdrawAmount={withdrawAmount}
          withdrawError={withdrawError}
          isWithdrawing={isWithdrawing}
          cavoPin={cavoPin}
          confirmPin={confirmPin}
          securityAnswerOne={securityAnswerOne}
          securityAnswerTwo={securityAnswerTwo}
          hasCavoPin={hasCavoPin}
          walletAddress={cavoWalletAddress}
          availableBalance={usdcDisplay}
          onAddressChange={(value) => {
            setWithdrawAddress(value)
            setWithdrawError(null)
          }}
          onChainChange={(value) => {
            setWithdrawChain(value)
            setWithdrawError(null)
          }}
          onAmountChange={setWithdrawAmount}
          onCavoPinChange={setCavoPin}
          onConfirmPinChange={setConfirmPin}
          onSecurityAnswerOneChange={setSecurityAnswerOne}
          onSecurityAnswerTwoChange={setSecurityAnswerTwo}
          onReview={prepareWithdraw}
          onSubmitPin={completeWithdraw}
          onBackToDetails={() => setWithdrawStep('details')}
          onClose={closeWithdraw}
          getChainLabel={getDestinationChainLabel}
          shortenAddress={shorten}
        />
      )}

      {isScanQrOpen && (
        <ScanQrModal
          onClose={() => setIsScanQrOpen(false)}
          onScan={handleQrScan}
        />
      )}

      {isEarnModalOpen && (
        <EarnModal
          mode={earnMode}
          earnStep={earnStep}
          earnAmount={earnAmount}
          earnToken={earnToken}
          vaults={earnVaults}
          earnError={earnError}
          isEarning={isEarning}
          cavoPin={cavoPin}
          confirmPin={confirmPin}
          securityAnswerOne={securityAnswerOne}
          securityAnswerTwo={securityAnswerTwo}
          hasCavoPin={hasCavoPin}
          walletAddress={cavoWalletAddress}
          availableBalance={earnToken === 'USDC' ? usdcDisplay : eurcDisplay}
          positionShares={Number(earnPositions.find(p => String(p.token).toUpperCase() === earnToken)?.shares) || 0}
          onAmountChange={setEarnAmount}
          onTokenChange={(token) => {
            setEarnToken(token)
            setEarnError(null)
          }}
          onModeChange={(nextMode) => {
            setEarnMode(nextMode)
            setEarnAmount('')
            setEarnError(null)
            setEarnStep('details')
          }}
          onCavoPinChange={setCavoPin}
          onConfirmPinChange={setConfirmPin}
          onSecurityAnswerOneChange={setSecurityAnswerOne}
          onSecurityAnswerTwoChange={setSecurityAnswerTwo}
          onReview={prepareEarn}
          onSubmitPin={completeEarn}
          onBackToDetails={() => setEarnStep('details')}
          onClose={closeEarn}
          shortenAddress={shorten}
        />
      )}

      {renderTransactionReceipt()}

      {sendSuccess && (
        <PaymentSuccessCelebration
          amount={sendSuccess.amount}
          token={sendSuccess.token}
          recipient={sendSuccess.recipient}
          txHash={sendSuccess.txHash}
          explorerUrl={sendSuccess.txHash ? `${getPaymentSourceChain(ARC_TESTNET_CHAIN).explorer}${sendSuccess.txHash}` : undefined}
          onClose={() => setSendSuccess(null)}
          onSendAnother={() => {
            setSendSuccess(null)
            openSend()
          }}
        />
      )}

      {swapSuccess && (
        <PaymentSuccessCelebration
          variant="swap"
          amount={swapSuccess.amountOut}
          token={swapSuccess.tokenOut}
          swapInAmount={swapSuccess.amountIn}
          swapInToken={swapSuccess.tokenIn}
          recipient={`${swapSuccess.amountIn} ${swapSuccess.tokenIn} swap`}
          txHash={swapSuccess.txHash}
          explorerUrl={swapSuccess.txHash ? `${getPaymentSourceChain(ARC_TESTNET_CHAIN).explorer}${swapSuccess.txHash}` : undefined}
          onClose={() => setSwapSuccess(null)}
          repeatLabel="Swap Again"
          onSendAnother={() => {
            setSwapSuccess(null)
            openSwap()
          }}
        />
      )}

      {earnSuccess && (
        <PaymentSuccessCelebration
          variant="earn"
          earnMode={earnSuccess.mode}
          amount={earnSuccess.amount}
          token={earnSuccess.token}
          earnShares={earnSuccess.shares}
          earnShareSymbol={earnSuccess.shareSymbol}
          destinationLabel={earnSuccess.destinationLabel}
          recipient={earnSuccess.shareSymbol}
          txHash={earnSuccess.txHash}
          explorerUrl={earnSuccess.txHash ? `${getPaymentSourceChain(ARC_TESTNET_CHAIN).explorer}${earnSuccess.txHash}` : undefined}
          onClose={() => setEarnSuccess(null)}
          repeatLabel={earnSuccess.mode === 'deposit' ? 'Deposit Again' : 'Withdraw Again'}
          onSendAnother={() => {
            const mode = earnSuccess.mode
            const token = earnSuccess.token as EarnToken
            setEarnSuccess(null)
            openEarn(mode, token)
          }}
        />
      )}

      {withdrawSuccess && (
        <PaymentSuccessCelebration
          amount={withdrawSuccess.amount}
          token="USDC"
          recipient={withdrawSuccess.recipient}
          txHash={withdrawSuccess.txHash}
          explorerUrl={withdrawSuccess.txHash ? `${getPaymentSourceChain(ARC_TESTNET_CHAIN).explorer}${withdrawSuccess.txHash}` : undefined}
          onClose={() => setWithdrawSuccess(null)}
          repeatLabel="Withdraw Again"
          onSendAnother={() => {
            setWithdrawSuccess(null)
            openWithdraw()
          }}
        />
      )}

      <div style={{ display: 'none' }}>
        <Link to="/dashboard">Dashboard</Link>
      </div>
    </>
  )
}
