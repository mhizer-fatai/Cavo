import { BACKEND_URL } from './config'

const AUTH_STORAGE_KEY = 'cavo.authUser'

// Access token lives in memory only (M3): localStorage is readable by any
// script on the page, so a stored token turns any XSS into session theft.
// Page reloads re-establish the token silently via the refresh cookie.
let memorySessionToken: string | null = null

export function setMemorySessionToken(token: string | null) {
  memorySessionToken = token
}

type StoredAuthUser = {
  cavoSessionToken?: string
  cavoSessionExpiresAt?: string
  userKey?: string
  [key: string]: unknown
}

function readStoredAuthUser(): StoredAuthUser | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function storeRefreshedSessionToken(token: string, expiresAt: string) {
  setMemorySessionToken(token)
  try {
    const user = readStoredAuthUser()
    if (!user) return
    const { cavoSessionToken: _dropped, ...rest } = user as StoredAuthUser & { cavoSessionToken?: unknown }
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
      ...rest,
      cavoSessionExpiresAt: expiresAt,
    }))
  } catch {
    // Storage failures must not break the request flow.
  }
}

function dispatchSessionExpired() {
  window.dispatchEvent(new CustomEvent('cavo:session-expired'))
}

// Single-flight refresh: concurrent 401s share one rotation request.
let refreshAttempt: Promise<{ token: string; expiresAt: string } | null> | null = null

async function tryRefreshSession(): Promise<{ token: string; expiresAt: string } | null> {
  if (!refreshAttempt) {
    refreshAttempt = (async () => {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 12000)
        try {
          const response = await fetch(`${BACKEND_URL}/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal,
          })
          if (!response.ok) return null
          const data = await response.json().catch(() => null)
          if (!data?.token) return null
          storeRefreshedSessionToken(data.token, data.expiresAt || '')
          return { token: data.token, expiresAt: data.expiresAt || '' }
        } finally {
          clearTimeout(timer)
        }
      } catch {
        return null
      } finally {
        refreshAttempt = null
      }
    })()
  }
  return refreshAttempt
}

function withAuthHeader(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return { ...init, headers }
}

async function apiFetch(path: string, init?: RequestInit, timeoutMs = 12000, retried = false) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BACKEND_URL}${path}`, { ...init, signal: controller.signal })
    if (response.status === 401 && !retried && !path.startsWith('/auth/')) {
      // Access token expired: rotate once via the refresh cookie, then retry.
      const refreshed = await tryRefreshSession()
      if (refreshed) {
        clearTimeout(timer)
        return apiFetch(path, withAuthHeader(init, refreshed.token), timeoutMs, true)
      }
      dispatchSessionExpired()
    } else if (response.status === 401) {
      dispatchSessionExpired()
    }
    return response
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('Request timed out. Please try again.')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function getStoredCavoSessionToken() {
  if (memorySessionToken) return memorySessionToken
  // Fallback for sessions established before the memory-only change.
  return readStoredAuthUser()?.cavoSessionToken ?? null
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = getStoredCavoSessionToken()
  return {
    ...(extra || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

// Money-movement calls carry a per-request idempotency key so an accidental
// replay (retry, double submit) returns the original result instead of
// executing the transfer twice.
function idempotencyHeaders(extra?: HeadersInit): HeadersInit {
  return {
    ...authHeaders(extra),
    'Idempotency-Key': crypto.randomUUID(),
  }
}

// Shared API response types.

export interface PaymentLink {
  id: string
  creator_address: string
  amount: number | null
  token: string
  note: string | null
  created_at: string
  expires_at?: string
  linkUrl?: string
  is_paid?: boolean
  tx_hash?: string | null
}

export interface Payment {
  id: string
  link_id: string
  payer_address: string
  recipient_address?: string | null
  source_chain?: string
  destination_chain?: string
  tx_hash: string
  amount: number | null
  token: string
  created_at: string
  payment_links?: {
    creator_address?: string
    note?: string | null
    token?: string
  }
}

export interface Profile {
  username: string
  wallet_address: string
  owner_address?: string
  avatar_url?: string | null
  created_at: string
}

// Payment link endpoints.

export async function createPaymentLink(payload: {
  creatorAddress: string
  amount?: string
  token: string
  note?: string
}): Promise<PaymentLink & { linkUrl: string }> {
  const res = await apiFetch('/links', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to create payment link')
  }
  return res.json()
}

export async function getPaymentLink(id: string): Promise<PaymentLink> {
  const res = await apiFetch(`/links/${id}`)
  if (!res.ok) throw new Error('Payment link not found')
  return res.json()
}

export async function getCreatorLinks(address: string): Promise<PaymentLink[]> {
  const res = await apiFetch(`/links/creator/${address.toLowerCase()}`, {
    headers: authHeaders(),
  })
  if (!res.ok) return []
  return res.json()
}

// Payment ledger endpoints.

export async function logPayment(payload: {
  linkId?: string
  payerAddress: string
  recipientAddress?: string
  sourceChain?: string
  destinationChain?: string
  txHash: string
  amount: string
  token: string
}): Promise<Payment> {
  const res = await apiFetch('/payments', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to log payment')
  }
  return res.json()
}

export async function getCreatorPayments(address: string): Promise<Payment[]> {
  const res = await apiFetch(`/payments/creator/${address.toLowerCase()}`, {
    headers: authHeaders(),
  })
  if (!res.ok) return []
  return res.json()
}

export async function getPayerPayments(address: string): Promise<Payment[]> {
  const res = await apiFetch(`/payments/payer/${address.toLowerCase()}`, {
    headers: authHeaders(),
  })
  if (!res.ok) return []
  return res.json()
}

// In-memory cache for token balances (address|contract) -> {bigint, timestamp}
const balanceCache = new Map<string, {value: bigint; ts: number}>()

// In-memory cache for token transfer history (address|contract) -> {[tx], timestamp}
const transferCache = new Map<string, {result: any[]; ts: number}>()

export async function getTokenBalance(address: string, contractAddress: string): Promise<bigint> {
  const cacheKey = `${address.toLowerCase()}|${contractAddress.toLowerCase()}`
  const cached = balanceCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < 30_000) {
    return cached.value
  }
  const params = new URLSearchParams({
    address: address.toLowerCase(),
    contractaddress: contractAddress.toLowerCase(),
  })
  try {
    const res = await apiFetch(`/arcscan/token-balance?${params.toString()}`)
    if (!res.ok) throw new Error('Failed to fetch token balance')
    const data = await res.json()
    const value = BigInt(data?.result || 0)
    balanceCache.set(cacheKey, { value, ts: Date.now() })
    return value
  } catch (e) {
    // If the API is unavailable, return cached value if we have one, otherwise 0
    const cached = balanceCache.get(cacheKey)
    return cached ? cached.value : 0n
  }
}

export async function getNativeBalance(address: string): Promise<bigint> {
  const params = new URLSearchParams({
    address: address.toLowerCase(),
  })
  const res = await apiFetch(`/arcscan/native-balance?${params.toString()}`)
  if (!res.ok) throw new Error('Failed to fetch native balance')
  const data = await res.json()
  return BigInt(data?.result || 0)
}

export async function getTokenTransfers(address: string, contractAddress: string): Promise<any[]> {
  const cacheKey = `${address.toLowerCase()}|${contractAddress.toLowerCase()}`
  const cached = transferCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < 60_000) {
    return cached.result
  }
  const params = new URLSearchParams({
    address: address.toLowerCase(),
    contractaddress: contractAddress.toLowerCase(),
  })
  try {
    const res = await apiFetch(`/arcscan/token-transfers?${params.toString()}`)
    if (!res.ok) throw new Error('Failed to fetch token transfer history')
    const data = await res.json()
    const result = Array.isArray(data?.result) ? data.result : []
    transferCache.set(cacheKey, { result, ts: Date.now() })
    return result
  } catch (e) {
    const hit = transferCache.get(cacheKey)
    return hit ? hit.result : []
  }
}

// Cavo profile endpoints.

export async function claimProfile(payload: { username: string; walletAddress: string }): Promise<Profile> {
  const res = await apiFetch('/profiles', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to claim username')
  }
  return res.json()
}

export async function getProfile(username: string): Promise<Profile> {
  const res = await apiFetch(`/profiles/${username}`)
  if (!res.ok) throw new Error('Profile not found')
  return res.json()
}

export async function getProfileByWallet(walletAddress: string): Promise<Profile | null> {
  const res = await apiFetch(`/profiles/wallet/${walletAddress.toLowerCase()}`)
  if (res.status === 404) return null
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to fetch profile')
  }
  const data = await res.json()
  return data || null
}

export async function updateProfileAvatar(username: string, avatarUrl: string | null): Promise<Profile> {
  const res = await apiFetch(`/profiles/${username}/avatar`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ avatarUrl }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to update profile picture')
  }
  return res.json()
}

// Circle developer-controlled wallet endpoints.


export interface CircleWallet {
  walletAddress: string
  walletId: string
  exists: boolean
  circleUserId?: string
  ownerUserKey?: string
  walletType?: string
  balance?: any[]
}

export async function getDeveloperControlledWallet(userKey: string): Promise<CircleWallet> {
  const res = await apiFetch(`/wallets/me?userKey=${encodeURIComponent(userKey.toLowerCase())}`, {
    headers: authHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to fetch developer-controlled wallet')
  }
  const data = await res.json()
  if (!data.exists) return { walletAddress: '', walletId: '', exists: false }
  return data
}

export async function createDeveloperControlledWallet(userKey: string): Promise<CircleWallet> {
  const res = await apiFetch('/wallets/create', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ userKey }),
  }, 45000)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const detail = (err as any).details?.message || (err as any).details?.error || (err as any).details
    throw new Error(detail || (err as any).error || 'Failed to create developer-controlled wallet')
  }
  return res.json()
}

export interface WalletTransactionStatus {
  trackingId: string
  status: string
  txHash?: string | null
  destinationChain?: string
  destinationAddress?: string
  amount?: string
  token?: string
  transaction?: any
  error?: string
}

export async function sendDeveloperControlledTransfer(payload: {
  userKey: string
  walletAddress: string
  walletId: string
  destinationAddress: string
  destinationChain?: string
  amount: string
  token?: string
  approvalId: string
}): Promise<{ trackingId?: string; status: string; txHash?: string; transaction?: any }> {
  const res = await apiFetch('/wallets/send', {
    method: 'POST',
    headers: idempotencyHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }, 45000)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = (data as any).details?.message || (data as any).details?.error || (data as any).details
    throw new Error(detail || (data as any).error || 'Failed to send payment')
  }
  return data
}

export async function bridgeDeveloperControlledTransfer(payload: {
  userKey: string
  walletAddress: string
  walletId: string
  destinationAddress: string
  destinationChain: string
  amount: string
  approvalId: string
}): Promise<{ trackingId?: string; status: string; txHash?: string; destinationChain?: string; transaction?: any }> {
  const res = await apiFetch('/wallets/bridge', {
    method: 'POST',
    headers: idempotencyHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }, 120000)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = (data as any).details?.message || (data as any).details?.error || (data as any).details
    throw new Error(detail || (data as any).error || 'Failed to bridge payment')
  }
  return data
}

export async function getWalletTransactionStatus(trackingId: string): Promise<WalletTransactionStatus> {
  const res = await apiFetch(`/wallets/transactions/${encodeURIComponent(trackingId)}`, {
    headers: authHeaders(),
  }, 20000)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = (data as any).details?.message || (data as any).details?.error || (data as any).details
    throw new Error(detail || (data as any).error || 'Failed to refresh transaction status')
  }
  return data
}

export async function requestCavoEmailCode(email: string): Promise<{
  ok: boolean
  email: string
  expiresAt: string
  cooldownSeconds: number
}> {
  const res = await apiFetch('/auth/email/request-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to send email code')
  }
  return res.json()
}

export async function verifyCavoEmailCode(payload: { email: string; code: string }): Promise<{
  authProvider: 'email'
  providerUserId: string
  email: string
  userKey: string
  session: { token: string; expiresAt: string; userKey: string }
  loginTicket: string
  loginTicketExpiresAt: string
}> {
  const res = await apiFetch('/auth/email/verify-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to verify email code')
  }
  return res.json()
}

// Session creation is gated server-side: pass a single-use loginTicket
// (issued by email OTP verification) or a Google credential (verified
// server-side via Google tokeninfo). Client-declared identity alone is rejected.
export async function createCavoSession(payload: {
  loginTicket?: string
  userToken?: string
  displayName?: string
}): Promise<{ token: string; expiresAt: string; userKey: string; sessionId: string }> {
  const res = await apiFetch('/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to create Cavo session')
  }
  return res.json()
}

export async function refreshCavoSession(): Promise<{ token: string; expiresAt: string; userKey: string; sessionId: string }> {
  const res = await apiFetch('/auth/refresh', {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Session refresh failed')
  }
  return res.json()
}

export async function logoutCavoSession(): Promise<void> {
  try {
    await apiFetch('/auth/logout', {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
    })
  } catch {
    // Logout is best-effort: local state is cleared regardless.
  }
}

export async function getCavoPinStatus(userKey: string): Promise<{ hasPin: boolean; hasRecoveryQuestion?: boolean; recoveryQuestion?: string | null; recoveryQuestions?: string[] }> {
  const res = await apiFetch(`/cavo-pin/status?userKey=${encodeURIComponent(userKey.toLowerCase())}`, {
    headers: authHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to fetch Cavo PIN status')
  }
  return res.json()
}

export async function setupCavoPin(payload: {
  userKey: string
  pin: string
  recoveryAnswers: string[]
}): Promise<{ hasPin: boolean }> {
  const res = await apiFetch('/cavo-pin/setup', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to set Cavo PIN')
  }
  return res.json()
}

export async function changeCavoPin(payload: {
  userKey: string
  currentPin: string
  newPin: string
}): Promise<{ ok: boolean }> {
  const res = await apiFetch('/cavo-pin/change', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to change Cavo PIN')
  }
  return res.json()
}

export async function setCavoPinRecoveryQuestion(payload: {
  userKey: string
  pin: string
  recoveryAnswers: string[]
}): Promise<{ ok: boolean; hasRecoveryQuestion: boolean; recoveryQuestion: string; recoveryQuestions?: string[] }> {
  const res = await apiFetch('/cavo-pin/recovery-question', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to save security question')
  }
  return res.json()
}

export async function recoverCavoPin(payload: {
  userKey: string
  recoveryAnswers: string[]
  newPin: string
}): Promise<{ ok: boolean }> {
  const res = await apiFetch('/cavo-pin/recover', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to recover Cavo PIN')
  }
  return res.json()
}

export async function approveCavoPinTransaction(payload: {
  userKey: string
  pin: string
  walletAddress: string
  walletId: string
  destinationAddress: string
  destinationChain?: string
  amount: string
  token?: 'USDC' | 'EURC'
  tokenOut?: 'USDC' | 'EURC'
  transactionType?: 'send' | 'swap' | 'earn'
}): Promise<{ approvalId: string; expiresAt: string }> {
  const res = await apiFetch('/cavo-pin/approve', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error || 'Failed to approve transaction')
  }
  return res.json()
}

// Swap endpoints.

export interface SwapQuote {
  provider: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  estimatedOutput: string
  minOut: string
  feeBps: number | null
  priceImpact: number | null
  expiresAt: string | null
}

export interface SwapExecutionResult {
  swapId: string
  status: string
  txHash?: string | null
  amountOut?: string | null
}

export async function getSwapQuote(payload: {
  userKey: string
  walletAddress: string
  tokenIn: 'USDC' | 'EURC'
  tokenOut: 'USDC' | 'EURC'
  amountIn: string
}): Promise<SwapQuote> {
  const res = await apiFetch('/swap/quote', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }, 45000)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as any).error || 'Failed to fetch swap quote')
  }
  return data
}

export async function executeSwap(payload: {
  userKey: string
  walletAddress: string
  walletId: string
  tokenIn: 'USDC' | 'EURC'
  tokenOut: 'USDC' | 'EURC'
  amountIn: string
  minOut?: string
  approvalId: string
}): Promise<SwapExecutionResult> {
  const res = await apiFetch('/swap/execute', {
    method: 'POST',
    headers: idempotencyHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }, 120000)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as any).error || 'Failed to execute swap')
  }
  return data
}

export interface SwapRecord {
  id: string
  user_key: string
  wallet_address: string
  token_in: string
  token_out: string
  amount_in: number
  min_out?: number | null
  amount_out?: number | null
  provider?: string
  status?: string
  tx_hash?: string | null
  created_at: string
}

export async function getSwapHistory(userKey: string): Promise<SwapRecord[]> {
  const res = await apiFetch(`/swap/history?userKey=${encodeURIComponent(userKey.toLowerCase())}`, {
    headers: authHeaders(),
  })
  if (!res.ok) return []
  const data = await res.json().catch(() => [])
  return Array.isArray(data) ? data : []
}

// Earn endpoints (ArcLend ERC-4626 vaults: deposit USDC/EURC, receive alvUSDC/alvEURC).

export interface EarnVault {
  id: string
  token: 'USDC' | 'EURC'
  asset: string
  vault: string
  provider: string
  experimental: boolean
  totalAssets: number
  totalSupply: number
  sharePrice: number
  apy: number | null
  apyPeriodDays: number | null
  maxDeposit?: number
  maxRedeem?: number
  shareBalance?: number
}

export interface EarnPosition {
  id?: string
  user_key: string
  wallet_address: string
  token: string
  vault: string
  shares: number
  principal: number
  updated_at?: string
  sharePrice?: number
  currentValue?: number
  earnings?: number
}

export interface EarnEvent {
  id: string
  user_key: string
  wallet_address: string
  token: string
  vault: string
  kind: 'deposit' | 'withdraw'
  amount: number
  shares: number
  tx_hash?: string | null
  bridge_tx_hash?: string | null
  destination_chain?: string | null
  destination_address?: string | null
  created_at: string
}

export async function getEarnVaults(walletAddress?: string): Promise<EarnVault[]> {
  const query = walletAddress ? `?walletAddress=${encodeURIComponent(walletAddress.toLowerCase())}` : ''
  const res = await apiFetch(`/earn/vaults${query}`)
  if (!res.ok) return []
  const data = await res.json().catch(() => [])
  return Array.isArray(data) ? data : []
}

export async function getEarnPositions(userKey: string): Promise<EarnPosition[]> {
  const res = await apiFetch(`/earn/positions?userKey=${encodeURIComponent(userKey.toLowerCase())}`, {
    headers: authHeaders(),
  })
  if (!res.ok) return []
  const data = await res.json().catch(() => [])
  return Array.isArray(data) ? data : []
}

export async function getEarnHistory(userKey: string): Promise<EarnEvent[]> {
  const res = await apiFetch(`/earn/history?userKey=${encodeURIComponent(userKey.toLowerCase())}`, {
    headers: authHeaders(),
  })
  if (!res.ok) return []
  const data = await res.json().catch(() => [])
  return Array.isArray(data) ? data : []
}

export async function depositEarn(payload: {
  userKey: string
  walletAddress: string
  walletId: string
  token: 'USDC' | 'EURC'
  amount: string
  approvalId: string
}): Promise<{ status: string; token: string; amount: number; shares: number; approveHash?: string; txHash?: string }> {
  const res = await apiFetch('/earn/deposit', {
    method: 'POST',
    headers: idempotencyHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }, 180000)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as any).error || 'Failed to deposit into earn vault')
  }
  return data
}

export async function withdrawEarn(payload: {
  userKey: string
  walletAddress: string
  walletId: string
  token: 'USDC' | 'EURC'
  shares: string
  approvalId: string
  destinationChain?: string
  destinationAddress?: string
}): Promise<{ status: string; token: string; shares: number; amount: number; txHash?: string; bridgeTxHash?: string | null; bridgeState?: string | null; destinationChain?: string; destinationAddress?: string }> {
  const res = await apiFetch('/earn/withdraw', {
    method: 'POST',
    headers: idempotencyHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }, 180000)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as any).error || 'Failed to withdraw from earn vault')
  }
  return data
}
