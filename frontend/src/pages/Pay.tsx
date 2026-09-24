import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAccount, useConfig, useReadContract, useWriteContract } from 'wagmi'
import { parseUnits } from 'viem'
import { QRCodeSVG } from 'qrcode.react'
import { AlertCircle, Check, CheckCircle2, ExternalLink, Hourglass, QrCode, RefreshCw, ShieldCheck } from 'lucide-react'
import { getPaymentLink, getTokenTransfers, logPayment, type PaymentLink } from '../lib/api'
import PaymentWalletButton from '../components/PaymentWalletButton'
import PaymentSuccessCelebration from '../components/PaymentSuccessCelebration'
import { ARC_TESTNET_CHAIN, CAVOPAY_CONTRACT_ADDRESS, CAVOPAYNT_SOURCE_CHAINS, TOKENS, arcTestnet, getPaymentSourceChain, type PaymentSourceChain } from '../lib/config'
import { ERC20_ABI, CAVOPAY_ABI } from '../lib/contracts'
import { ensureWalletChain, waitForHash } from '../lib/transactions'
import { bridgePaymentToArc } from '../lib/bridge'

function shorten(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`
}

function uuidToBytes32(uuid: string): `0x${string}` {
  const hex = uuid.replace(/-/g, '')
  return `0x${hex.padEnd(64, '0')}` as `0x${string}`
}

type Step = 'idle' | 'approving' | 'paying' | 'done'
type TxFeedback = 'idle' | 'preparing' | 'wallet' | 'submitted' | 'confirming' | 'recording' | 'success'

const DEMO_LINK: PaymentLink = {
  id: 'demo',
  creator_address: '0x1234567890abcdef1234567890abcdef12345678',
  amount: 25,
  token: 'USDC',
  note: 'Demo payment - Coffee and lunch',
  created_at: new Date().toISOString(),
}

export default function PayPage() {
  const { linkId } = useParams<{ linkId: string }>()
  const { address, isConnected, chainId } = useAccount()
  const wagmiConfig = useConfig()
  const { writeContractAsync } = useWriteContract()

  const [link, setLink] = useState<PaymentLink | null>(null)
  const [fetchErr, setFetchErr] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [showSuccessCelebration, setShowSuccessCelebration] = useState(false)
  const [payErr, setPayErr] = useState<string | null>(null)
  const [timeLeft, setTimeLeft] = useState<number | null>(null)
  const [sourceChain, setSourceChain] = useState<PaymentSourceChain>(ARC_TESTNET_CHAIN)
  const [qrOpen, setQrOpen] = useState(false)
  const [txFeedback, setTxFeedback] = useState<TxFeedback>('idle')

  useEffect(() => {
    if (!linkId) return
    if (linkId === 'demo') {
      setLink(DEMO_LINK)
      return
    }
    getPaymentLink(linkId)
      .then(nextLink => {
        setLink(nextLink)
        if (nextLink.is_paid && nextLink.tx_hash) {
          setTxHash(nextLink.tx_hash)
          setStep('done')
          setShowSuccessCelebration(false)
        }
      })
      .catch(() => setFetchErr('Payment link not found'))
  }, [linkId])

  const isDemo = link?.id === 'demo'
  const token = link?.token === 'EURC' ? TOKENS.EURC : TOKENS.USDC
  const amountRaw = link?.amount ? parseUnits(link.amount.toString(), token.decimals) : 0n
  const isEurc = token.symbol === 'EURC'
  const effectiveSourceChain = isEurc ? ARC_TESTNET_CHAIN : sourceChain
  const isArcSource = effectiveSourceChain === ARC_TESTNET_CHAIN
  const effectiveSelectedChain = getPaymentSourceChain(effectiveSourceChain)
  const selectedChain = getPaymentSourceChain(sourceChain)
  const isWrongChain = isConnected && chainId !== effectiveSelectedChain.wagmiChain.id

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, CAVOPAY_CONTRACT_ADDRESS] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: !!address && amountRaw > 0n },
  })

  const hasAllowance = !isArcSource || (allowance !== undefined && allowance >= amountRaw && amountRaw > 0n)

  useEffect(() => {
    if (!link || !link.expires_at || step === 'done' || isDemo) return

    const tick = () => {
      const diff = Math.floor((new Date(link.expires_at!).getTime() - Date.now()) / 1000)
      if (diff <= 0) {
        setTimeLeft(0)
        setPayErr('This payment link has expired.')
      } else {
        setTimeLeft(diff)
      }
    }

    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [link, step, isDemo])

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
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

  const handleApprove = async () => {
    if (!address || !link || isDemo || !isArcSource) return
    setPayErr(null)
    setStep('approving')
    setTxFeedback('wallet')
    try {
      await ensureWalletChain(wagmiConfig, chainId, arcTestnet.id)
      const approveHash = await writeContractAsync({
        address: token.address,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [CAVOPAY_CONTRACT_ADDRESS, amountRaw],
        chainId: arcTestnet.id,
      })
      setTxFeedback('submitted')
      await waitForHash(wagmiConfig, arcTestnet.id, approveHash)
      await refetchAllowance()
      setTxFeedback('success')
      setStep('idle')
    } catch (error) {
      setPayErr(error instanceof Error ? error.message : 'Approval rejected')
      setTxFeedback('idle')
      setStep('idle')
    }
  }

  const handlePay = async () => {
    if (!address || !link || isDemo) return
    setPayErr(null)
    setStep('paying')
    setTxFeedback('preparing')
    try {
      let hash: `0x${string}` | string | null = null
      const paymentStartedAt = Date.now()
      if (isEurc && sourceChain !== ARC_TESTNET_CHAIN) setSourceChain(ARC_TESTNET_CHAIN)

      if (effectiveSourceChain === ARC_TESTNET_CHAIN) {
        await ensureWalletChain(wagmiConfig, chainId, arcTestnet.id)
        setTxFeedback('wallet')
        hash = await writeContractAsync({
          address: CAVOPAY_CONTRACT_ADDRESS,
          abi: CAVOPAY_ABI,
          functionName: 'pay',
          args: [
            uuidToBytes32(link.id),
            link.creator_address as `0x${string}`,
            token.address,
            amountRaw,
            link.note ?? '',
          ],
          chainId: arcTestnet.id,
        })
        setTxFeedback('submitted')
        await waitForHash(wagmiConfig, arcTestnet.id, hash as `0x${string}`)
      } else {
        setTxFeedback('preparing')
        await ensureWalletChain(wagmiConfig, chainId, effectiveSelectedChain.wagmiChain.id)
        setTxFeedback('wallet')
        const bridge = await bridgePaymentToArc({
          sourceChain: effectiveSourceChain,
          recipientAddress: link.creator_address,
          amount: link.amount?.toString() ?? '0',
        })
        hash = bridge.txHash
        setTxFeedback('submitted')
        if (!hash) {
          hash = await waitForArcSettlementHash(link.creator_address, amountRaw, paymentStartedAt)
        }
      }

      if (!hash) throw new Error('Payment submitted, but transaction hash is not available yet.')
      setTxFeedback('recording')
      setTxHash(hash)
      setStep('done')
      setTxFeedback('success')
      setShowSuccessCelebration(true)
      setLink(previous => previous ? { ...previous, is_paid: true, tx_hash: hash } : previous)

      try {
        await logPayment({
          linkId: link.id,
          payerAddress: address,
          recipientAddress: link.creator_address,
          sourceChain: ARC_TESTNET_CHAIN,
          destinationChain: ARC_TESTNET_CHAIN,
          txHash: hash,
          amount: link.amount?.toString() ?? '0',
          token: link.token,
        })
      } catch (logError) {
        console.warn('Payment succeeded but receipt logging failed:', logError)
      }
    } catch (error) {
      setPayErr(error instanceof Error ? error.message : 'Transaction rejected')
      setTxFeedback('idle')
      setStep('idle')
    }
  }

  const feedbackLabel = (() => {
    if (txFeedback === 'preparing') return 'Preparing payment...'
    if (txFeedback === 'wallet') return 'Waiting for wallet approval...'
    if (txFeedback === 'submitted' || txFeedback === 'confirming' || txFeedback === 'recording') return 'Transaction submitted. Waiting for confirmation...'
    if (txFeedback === 'success') return 'Transaction confirmed'
    if (step === 'approving') return 'Waiting for wallet approval...'
    if (step === 'paying') return 'Processing payment...'
    return ''
  })()

  if (fetchErr) return (
    <div className="pay-page">
      <div className="card err-card" style={{ textAlign: 'center', maxWidth: 400 }}>
        <AlertCircle size={48} style={{ color: 'var(--red)', marginBottom: 16, marginLeft: 'auto', marginRight: 'auto' }} />
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Link Not Found</h2>
        <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 24 }}>This payment link does not exist or has been removed.</p>
        <Link to="/" className="btn btn-primary btn-full">Create Your Own Link</Link>
      </div>
    </div>
  )

  if (!link) return (
    <div className="load-wrap">
      <RefreshCw className="loader" style={{ animation: 'spin 1.5s linear infinite' }} />
      <span>Loading payment details...</span>
    </div>
  )

  if (step === 'done' && txHash && showSuccessCelebration) return (
    <PaymentSuccessCelebration
      amount={link.amount?.toString() ?? ''}
      token={token.symbol}
      recipient={link.creator_address}
      txHash={txHash}
      explorerUrl={`${effectiveSelectedChain.explorer}${txHash}`}
      onClose={() => setShowSuccessCelebration(false)}
    />
  )

  if (step === 'done' && txHash) return (
    <div className="pay-page">
      <div className="card glass" style={{ width: '100%', maxWidth: 520, textAlign: 'center', padding: 36 }}>
        <CheckCircle2 size={48} style={{ color: 'var(--green)', margin: '0 auto 18px' }} />
        <h1 style={{ fontSize: 30, fontWeight: 800, marginBottom: 10 }}>Payment Already Completed</h1>
        <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 24 }}>This payment link has already been paid.</p>
        <div className="pin-summary" style={{ textAlign: 'left', marginBottom: 22 }}>
          <div><span>Amount</span><strong>{link.amount} {token.symbol}</strong></div>
          <div><span>Recipient</span><strong>{shorten(link.creator_address)}</strong></div>
          <div><span>Network</span><strong>Arc Testnet</strong></div>
          <div><span>TX Hash</span><strong>{shorten(txHash)}</strong></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <a className="btn btn-secondary" href={`${effectiveSelectedChain.explorer}${txHash}`} target="_blank" rel="noopener noreferrer">
            View TX <ExternalLink size={14} />
          </a>
          <Link to="/" className="btn btn-primary">Done</Link>
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
              <span className="checkout-kicker">Payment request</span>
              <h1>Complete Payment</h1>
              <p>Review all details, choose the network you are paying from, then approve the transaction in your wallet.</p>
            </div>
            <div className="checkout-amount-box">
              <span>Total due</span>
              <strong>{link.amount || 'Open'} {token.symbol}</strong>
            </div>
          </div>

          <div className="checkout-details-grid">
            <div className="checkout-detail-row"><span>Recipient wallet</span><strong>{shorten(link.creator_address)}</strong></div>
            <div className="checkout-detail-row"><span>Token</span><strong>{token.symbol}</strong></div>
            <div className="checkout-detail-row"><span>Payment amount</span><strong>{link.amount ? `${link.amount} ${token.symbol}` : 'Open amount'}</strong></div>
            <div className="checkout-detail-row"><span>Platform fee</span><strong>{link.amount ? `${(link.amount * 0.005).toFixed(4)} ${token.symbol}` : '0.00'}</strong></div>
            <div className="checkout-detail-row"><span>Pay from</span><strong>{effectiveSelectedChain.label}</strong></div>
            <div className="checkout-detail-row"><span>Settles on</span><strong>Arc Testnet</strong></div>
            {timeLeft !== null && !isDemo && (
              <div className="checkout-detail-row">
                <span>Expires in</span>
                <strong className={`checkout-timer ${timeLeft < 300 ? 'urgent' : ''}`}>
                  <Hourglass size={12} /> {formatTime(timeLeft)}
                </strong>
              </div>
            )}
            {link.note && <div className="checkout-detail-row checkout-detail-row-wide"><span>Note</span><strong>{link.note}</strong></div>}
          </div>

          <div className="checkout-control-panel">
            <div className="form-group">
              <label className="form-label">Pay from network</label>
              <select className="form-input" value={sourceChain} disabled={isEurc} onChange={event => setSourceChain(event.target.value as PaymentSourceChain)}>
                {CAVOPAYNT_SOURCE_CHAINS.map(chain => <option key={chain.value} value={chain.value}>{chain.label}</option>)}
              </select>
              {isEurc && <p className="checkout-helper">EURC payments are Arc-only right now.</p>}
            </div>

            {!isDemo && (
              <div>
                <button type="button" className="qr-drawer-btn" onClick={() => setQrOpen(!qrOpen)}>
                  <QrCode size={16} />
                  <span>{qrOpen ? 'Hide QR Code' : 'Scan QR to Pay'}</span>
                </button>
                <div className={`qr-drawer-content ${qrOpen ? 'open' : ''}`}>
                  <div className="qr-box"><QRCodeSVG value={window.location.href} size={110} /></div>
                  <p className="qr-subtitle">Scan to pay with mobile wallet</p>
                </div>
              </div>
            )}

            {isDemo && <div className="alert alert-warn">This is a demo payment link. Complete account creation to receive live payments.</div>}
            {isWrongChain && <div className="alert alert-warn">Please switch your wallet network to {effectiveSelectedChain.label}.</div>}
            {payErr && <div className="alert alert-err">{payErr}</div>}

            {feedbackLabel && (
              <div className={`tx-feedback ${txFeedback === 'success' ? 'success' : ''}`}>
                <span className={txFeedback === 'success' ? 'tx-feedback-check' : 'tx-feedback-spinner'}>
                  {txFeedback === 'success' ? <Check size={14} /> : null}
                </span>
                <strong>{feedbackLabel}</strong>
              </div>
            )}

            {isConnected && link.amount && !isDemo && (
              <div className="steps-checklist">
                {[
                  ...(isArcSource ? [{ label: 'Approve token spend limit', done: hasAllowance || step === 'paying' || step === 'done', active: !hasAllowance && step === 'approving' }] : []),
                  { label: isArcSource ? 'Execute payment on Arc Testnet' : 'Bridge token to Arc Testnet', done: step === 'done', active: step === 'paying' },
                ].map((item, index) => (
                  <div key={item.label} className={`step-checklist-item ${item.active ? 'active' : ''}`}>
                    <div className={`step-node ${item.done ? 'completed' : item.active ? 'active' : 'idle'}`}>
                      {item.done ? <Check size={12} /> : index + 1}
                    </div>
                    <span className="step-item-text">{item.label}</span>
                  </div>
                ))}
              </div>
            )}

            {!isConnected ? (
              <PaymentWalletButton className="btn-full" />
            ) : isWrongChain ? (
              <button className="btn btn-primary btn-full" onClick={() => ensureWalletChain(wagmiConfig, chainId, effectiveSelectedChain.wagmiChain.id).catch(error => setPayErr(error.message || 'Failed to switch network'))}>
                Switch to {effectiveSelectedChain.label}
              </button>
            ) : isDemo ? (
              <Link to="/" className="btn btn-primary btn-full">Create Your Own Link</Link>
            ) : !link.amount ? (
              <p className="checkout-no-amount-warning">This payment link has no fixed amount.</p>
            ) : timeLeft !== null && timeLeft <= 0 ? (
              <button className="btn btn-ghost btn-full" disabled>Link Expired</button>
            ) : hasAllowance ? (
              <button id="pay-now-btn" className="btn btn-success btn-full" disabled={step === 'paying'} onClick={handlePay}>
                {step === 'paying' ? feedbackLabel || 'Processing payment...' : `Pay ${link.amount} ${token.symbol}`}
              </button>
            ) : (
              <button id="approve-btn" className="btn btn-primary btn-full" disabled={step === 'approving'} onClick={handleApprove}>
                {step === 'approving' ? feedbackLabel || 'Waiting for approval...' : `Approve ${token.symbol} Spending`}
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
