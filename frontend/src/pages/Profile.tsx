import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAccount, useConfig, useWriteContract } from 'wagmi'
import { parseUnits } from 'viem'
import { AlertCircle, Check, CheckCircle2, Copy, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react'
import { getProfile, getTokenTransfers, logPayment, type Profile } from '../lib/api'
import PaymentWalletButton from '../components/PaymentWalletButton'
import PaymentSuccessCelebration from '../components/PaymentSuccessCelebration'
import { ARC_TESTNET_CHAIN, CAVOPAYNT_SOURCE_CHAINS, TOKENS, arcTestnet, getPaymentSourceChain, type PaymentSourceChain } from '../lib/config'
import { ERC20_ABI } from '../lib/contracts'
import { ensureWalletChain, waitForHash } from '../lib/transactions'
import { bridgePaymentToArc } from '../lib/bridge'

function shorten(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`
}

type Step = 'idle' | 'paying' | 'done'
type TxFeedback = 'idle' | 'preparing' | 'wallet' | 'submitted' | 'confirming' | 'recording' | 'success'

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>()
  const { address, isConnected, chainId } = useAccount()
  const wagmiConfig = useConfig()
  const { writeContractAsync } = useWriteContract()

  const [profile, setProfile] = useState<Profile | null>(null)
  const [fetchErr, setFetchErr] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [tokenSymbol, setTokenSymbol] = useState<'USDC' | 'EURC'>('USDC')
  const [sourceChain, setSourceChain] = useState<PaymentSourceChain>(ARC_TESTNET_CHAIN)
  const [step, setStep] = useState<Step>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [showSuccessCelebration, setShowSuccessCelebration] = useState(false)
  const [payErr, setPayErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [txFeedback, setTxFeedback] = useState<TxFeedback>('idle')

  const token = TOKENS[tokenSymbol]
  const effectiveSourceChain = tokenSymbol === 'EURC' ? ARC_TESTNET_CHAIN : sourceChain
  const selectedChain = getPaymentSourceChain(effectiveSourceChain)
  const isWrongChain = isConnected && chainId !== selectedChain.wagmiChain.id

  useEffect(() => {
    if (!username) return
    getProfile(username)
      .then(setProfile)
      .catch(() => setFetchErr('Profile not found'))
  }, [username])

  const handleCopyAddress = async () => {
    if (!profile) return
    await navigator.clipboard.writeText(profile.wallet_address)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const waitForArcSettlementHash = async (recipientAddress: string, expectedAmount: bigint, startedAt: number) => {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, attempt === 0 ? 2500 : 5000))
      const transfers = await getTokenTransfers(recipientAddress, token.address).catch(() => [])
      const match = transfers.find((transfer: any) => {
        const to = String(transfer.to || '').toLowerCase()
        const value = BigInt(transfer.value || 0)
        const timestamp = Number(transfer.timeStamp || 0) * 1000
        return to === recipientAddress.toLowerCase()
          && value === expectedAmount
          && timestamp >= startedAt - 30000
          && /^0x[a-fA-F0-9]{64}$/.test(String(transfer.hash || ''))
      })
      if (match?.hash) return match.hash as string
    }
    return null
  }

  const handlePay = async () => {
    if (!address || !profile || !amount || parseFloat(amount) <= 0) return
    setPayErr(null)
    setStep('paying')
    setTxFeedback('preparing')
    try {
      let hash: `0x${string}` | string | null = null
      const paymentStartedAt = Date.now()
      const amountRaw = parseUnits(amount, token.decimals)

      if (effectiveSourceChain === ARC_TESTNET_CHAIN) {
        await ensureWalletChain(wagmiConfig, chainId, arcTestnet.id)
        setTxFeedback('wallet')
        hash = await writeContractAsync({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [profile.wallet_address as `0x${string}`, amountRaw],
          chainId: arcTestnet.id,
        })
        setTxFeedback('submitted')
        await waitForHash(wagmiConfig, arcTestnet.id, hash as `0x${string}`)
      } else {
        setTxFeedback('preparing')
        await ensureWalletChain(wagmiConfig, chainId, selectedChain.wagmiChain.id)
        setTxFeedback('wallet')
        const bridge = await bridgePaymentToArc({
          sourceChain: effectiveSourceChain,
          recipientAddress: profile.wallet_address,
          amount,
        })
        hash = bridge.txHash
        setTxFeedback('submitted')
        if (!hash) {
          hash = await waitForArcSettlementHash(profile.wallet_address, amountRaw, paymentStartedAt)
        }
      }

      if (!hash) throw new Error('Payment submitted, but transaction hash is not available yet.')

      setTxFeedback('recording')
      setTxHash(hash)
      setStep('done')
      setTxFeedback('success')
      setShowSuccessCelebration(true)
      try {
        await logPayment({
          payerAddress: address,
          recipientAddress: profile.wallet_address,
          sourceChain: ARC_TESTNET_CHAIN,
          destinationChain: ARC_TESTNET_CHAIN,
          txHash: hash,
          amount,
          token: tokenSymbol,
        })
      } catch (logError) {
        console.warn('Payment succeeded but receipt logging failed:', logError)
      }
    } catch (error) {
      setPayErr(error instanceof Error ? error.message : 'Payment failed')
      setTxFeedback('idle')
      setStep('idle')
    }
  }

  const feedbackLabel = (() => {
    if (txFeedback === 'preparing') return 'Preparing payment...'
    if (txFeedback === 'wallet') return 'Waiting for wallet approval...'
    if (txFeedback === 'submitted' || txFeedback === 'confirming' || txFeedback === 'recording') return 'Transaction submitted. Waiting for confirmation...'
    if (txFeedback === 'success') return 'Transaction confirmed'
    if (step === 'paying') return 'Processing payment...'
    return ''
  })()

  if (fetchErr) return (
    <div className="pay-page">
      <div className="card err-card" style={{ textAlign: 'center', maxWidth: 400 }}>
        <AlertCircle size={48} style={{ color: 'var(--red)', marginBottom: 16, marginLeft: 'auto', marginRight: 'auto' }} />
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Profile Not Found</h2>
        <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 24 }}>The username @{username} does not exist.</p>
        <Link to="/" className="btn btn-primary btn-full">Go Home</Link>
      </div>
    </div>
  )

  if (!profile) return (
    <div className="load-wrap">
      <RefreshCw className="loader" style={{ animation: 'spin 1.5s linear infinite' }} />
      <span>Loading profile details...</span>
    </div>
  )

  if (step === 'done' && txHash && showSuccessCelebration) return (
    <PaymentSuccessCelebration
      amount={amount}
      token={tokenSymbol}
      recipient={`@${profile.username}`}
      txHash={txHash}
      explorerUrl={`${selectedChain.explorer}${txHash}`}
      onClose={() => setShowSuccessCelebration(false)}
      onSendAnother={() => {
        setShowSuccessCelebration(false)
        setStep('idle')
        setTxHash(null)
        setAmount('')
      }}
    />
  )

  if (step === 'done' && txHash) return (
    <div className="pay-page">
      <div className="card glass" style={{ width: '100%', maxWidth: 520, textAlign: 'center', padding: 36 }}>
        <CheckCircle2 size={48} style={{ color: 'var(--green)', margin: '0 auto 18px' }} />
        <h1 style={{ fontSize: 30, fontWeight: 800, marginBottom: 10 }}>Payment Sent</h1>
        <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 24 }}>Your payment to @{profile.username} was completed.</p>
        <div className="pin-summary" style={{ textAlign: 'left', marginBottom: 22 }}>
          <div><span>Amount</span><strong>{amount} {tokenSymbol}</strong></div>
          <div><span>Recipient</span><strong>@{profile.username}</strong></div>
          <div><span>Network</span><strong>Arc Testnet</strong></div>
          <div><span>TX Hash</span><strong>{shorten(txHash)}</strong></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <a className="btn btn-secondary" href={`${selectedChain.explorer}${txHash}`} target="_blank" rel="noopener noreferrer">
            View TX <ExternalLink size={14} />
          </a>
          <button className="btn btn-primary" onClick={() => {
            setStep('idle')
            setTxHash(null)
            setAmount('')
          }}>Send Again</button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="pay-page">
      <div className="checkout-shell">
        <div className="checkout-card-pro">
          <div className="checkout-topbar">
            <Link to="/" className="checkout-brand">
              <img src="/cavopay-logo.png" alt="Cavopay" />
              <span>Cavopay</span>
            </Link>
            <PaymentWalletButton />
          </div>

          <div className="checkout-hero">
            <div>
              <span className="checkout-kicker">Cavopay profile</span>
              <h1>Pay @{profile.username}</h1>
              <p>Enter the amount, choose the token and network, then approve the wallet transaction.</p>
            </div>
            <div className="profile-avatar-circle">
              {profile.avatar_url ? (
                <img src={profile.avatar_url} alt={`${profile.username} profile`} />
              ) : (
                profile.username.charAt(0).toUpperCase()
              )}
            </div>
          </div>

          <div className="checkout-details-grid">
            <div className="checkout-detail-row"><span>Recipient</span><strong>@{profile.username}</strong></div>
            <div className="checkout-detail-row">
              <span>Recipient wallet</span>
              <strong className="recipient-wallet-container">
                {shorten(profile.wallet_address)}
                <button onClick={handleCopyAddress} className="copy-address-btn" title="Copy address">
                  {copied ? <Check size={14} className="copy-check-icon" /> : <Copy size={14} />}
                </button>
              </strong>
            </div>
            <div className="checkout-detail-row"><span>Token</span><strong>{tokenSymbol}</strong></div>
            <div className="checkout-detail-row"><span>Amount</span><strong>{amount ? `${amount} ${tokenSymbol}` : 'Not entered'}</strong></div>
            <div className="checkout-detail-row"><span>Pay from</span><strong>{selectedChain.label}</strong></div>
            <div className="checkout-detail-row"><span>Settles on</span><strong>Arc Testnet</strong></div>
          </div>

          <div className="checkout-control-panel">
            <div className="amount-input-container">
              <label className="form-label">Amount</label>
              <div className="amount-input-wrapper">
                <input
                  type="number"
                  value={amount}
                  onChange={event => setAmount(event.target.value)}
                  placeholder="0.00"
                  className="amount-field"
                />
              </div>
              <div className="token-select-pills">
                {(['USDC', 'EURC'] as const).map(symbol => (
                  <button
                    key={symbol}
                    type="button"
                    className={`token-pill ${tokenSymbol === symbol ? 'active' : ''}`}
                    onClick={() => {
                      setTokenSymbol(symbol)
                      if (symbol === 'EURC') setSourceChain(ARC_TESTNET_CHAIN)
                    }}
                  >
                    {symbol}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Pay from network</label>
              <select className="form-input" value={sourceChain} disabled={tokenSymbol === 'EURC'} onChange={event => setSourceChain(event.target.value as PaymentSourceChain)}>
                {CAVOPAYNT_SOURCE_CHAINS.map(chain => <option key={chain.value} value={chain.value}>{chain.label}</option>)}
              </select>
              <p className="checkout-helper">{tokenSymbol === 'EURC' ? 'EURC is Arc-only right now.' : 'Recipient settles on Arc Testnet.'}</p>
            </div>

            {isWrongChain && <div className="alert alert-warn">Please switch your wallet network to {selectedChain.label}.</div>}
            {payErr && <div className="alert alert-err">{payErr}</div>}

            {feedbackLabel && (
              <div className={`tx-feedback ${txFeedback === 'success' ? 'success' : ''}`}>
                <span className={txFeedback === 'success' ? 'tx-feedback-check' : 'tx-feedback-spinner'}>
                  {txFeedback === 'success' ? <Check size={14} /> : null}
                </span>
                <strong>{feedbackLabel}</strong>
              </div>
            )}

            {!isConnected ? (
              <PaymentWalletButton className="btn-full" />
            ) : isWrongChain ? (
              <button className="btn btn-primary btn-full" onClick={() => ensureWalletChain(wagmiConfig, chainId, selectedChain.wagmiChain.id).catch(error => setPayErr(error.message || 'Failed to switch network'))}>
                Switch to {selectedChain.label}
              </button>
            ) : (
              <button className="btn btn-primary btn-full" disabled={step === 'paying' || !amount || parseFloat(amount) <= 0} onClick={handlePay}>
                {step === 'paying' ? feedbackLabel || 'Processing payment...' : `Send ${amount || '0'} ${tokenSymbol} to @${profile.username}`}
              </button>
            )}

            <div className="checkout-security-note">
              <ShieldCheck size={15} />
              <span>Secured with wallet approval. Cavopay never asks for your wallet seed phrase.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
