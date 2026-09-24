import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, Check, Copy } from 'lucide-react'
import { Link } from 'react-router-dom'

interface ConfettiPiece {
  id: number
  x: number
  y: number
  rotation: number
  delay: number
  duration: number
  color: string
  size: number
  shape: 'circle' | 'square' | 'triangle'
}

type PaymentSuccessCelebrationProps = {
  amount: string
  token: string
  recipient: string
  txHash?: string
  explorerUrl?: string
  onClose: () => void
  onSendAnother?: () => void
  variant?: 'send' | 'swap' | 'earn'
  swapInAmount?: string
  swapInToken?: string
  earnMode?: 'deposit' | 'withdraw'
  earnShares?: string
  earnShareSymbol?: string
  destinationLabel?: string
  repeatLabel?: string
}

/**
 * Reusable celebration page with birthday-style confetti and receipt card.
 * Supports a 'send' variant (default) and a 'swap' variant.
 */
export default function PaymentSuccessCelebration({
  amount,
  token,
  recipient,
  txHash,
  explorerUrl,
  onClose,
  onSendAnother,
  variant = 'send',
  swapInAmount,
  swapInToken,
  earnMode,
  earnShares,
  earnShareSymbol,
  destinationLabel,
  repeatLabel,
}: PaymentSuccessCelebrationProps) {
  const isSwap = variant === 'swap'
  const isEarn = variant === 'earn'
  const [pieces, setPieces] = useState<ConfettiPiece[]>([])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const shapes: Array<'circle' | 'square' | 'triangle'> = ['circle', 'square', 'triangle']
    const colors = [
      '#0E6B4E', '#2F8F6B', '#63B394', '#D9B65A', '#C9A227',
      '#5B6B63', '#8FA69B', '#9A6A1F', '#B3362B', '#E4E9E6',
    ]

    const arr: ConfettiPiece[] = []
    for (let i = 0; i < 80; i++) {
      const angle = Math.random() * 2 * Math.PI
      const distance = 80 + Math.random() * 240
      const x = Math.cos(angle) * distance
      const y = Math.sin(angle) * distance - 80

      arr.push({
        id: i,
        x,
        y,
        rotation: Math.random() * 720 - 360,
        delay: Math.random() * 0.3,
        duration: 1.6 + Math.random() * 1.4,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 6 + Math.random() * 8,
        shape: shapes[Math.floor(Math.random() * shapes.length)],
      })
    }
    setPieces(arr)
  }, [])

  const copyHash = async () => {
    if (!txHash) return
    await navigator.clipboard.writeText(txHash)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const formatAddress = (addr: string) => {
    if (addr.startsWith('@')) return addr
    if (addr.startsWith('0x') && addr.length > 12) {
      return `${addr.slice(0, 6)}...${addr.slice(-4)}`
    }
    return addr
  }

  return (
    <div className="overlay" style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
      <div className="confirm-card" style={{ position: 'relative', overflow: 'hidden' }}>
        {/* Particle Confetti System */}
        <div className="confetti-container" aria-hidden="true">
          {pieces.map(p => {
            let borderRadius = '0%'
            let clipPath = 'none'
            if (p.shape === 'circle') {
              borderRadius = '50%'
            } else if (p.shape === 'triangle') {
              clipPath = 'polygon(50% 0%, 0% 100%, 100% 100%)'
            }

            return (
              <div
                key={p.id}
                className="confetti-piece"
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  width: `${p.size}px`,
                  height: `${p.shape === 'triangle' ? p.size * 0.86 : p.size}px`,
                  backgroundColor: p.color,
                  borderRadius,
                  clipPath,
                  transform: 'translate(-50%, -50%)',
                  opacity: 0,
                  '--tx': `${p.x}px`,
                  '--ty': `${p.y + 120}px`,
                  '--rot': `${p.rotation}deg`,
                  animation: `confetti-explosion ${p.duration}s cubic-bezier(0.1, 0.8, 0.3, 1) ${p.delay}s forwards`,
                } as React.CSSProperties}
              />
            )
          })}
        </div>

        {/* Checkmark icon */}
        <div className="check-circle">
          <CheckCircle2 size={36} />
        </div>

        <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 6, color: 'var(--ink)' }}>
          {isSwap ? 'Swap Complete!' : isEarn ? (earnMode === 'withdraw' ? 'Withdrawal Complete!' : 'Deposit Complete!') : 'Payment Sent!'}
        </h2>
        <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 24 }}>
          {isSwap && swapInAmount && swapInToken
            ? `You swapped ${swapInAmount} ${swapInToken} for ${amount} ${token}.`
            : isEarn && earnShares && earnShareSymbol
              ? earnMode === 'withdraw'
                ? `You withdrew ${amount} ${token} from ${earnShareSymbol}.${destinationLabel ? ` Bridging to ${destinationLabel} via CCTP.` : ''}`
                : `You deposited ${amount} ${token} for ${earnShares} ${earnShareSymbol}.`
              : `Your payment of ${amount} ${token} was successfully processed.`}
        </p>

        {/* Receipt table */}
        <div className="tx-box">
          <div className="tx-label">{isSwap ? 'Swap Receipt' : isEarn ? 'Earn Receipt' : 'Payment Receipt'}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {isEarn && earnShares && earnShareSymbol ? (
              <>
                {earnMode === 'withdraw' ? (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: 'var(--text3)' }}>Shares burned</span>
                      <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{earnShares} {earnShareSymbol}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: 'var(--text3)' }}>Received</span>
                      <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{amount} {token}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: 'var(--text3)' }}>Deposited</span>
                      <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{amount} {token}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: 'var(--text3)' }}>Shares received</span>
                      <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{earnShares} {earnShareSymbol}</span>
                    </div>
                  </>
                )}
              </>
            ) : isSwap && swapInAmount && swapInToken ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--text3)' }}>Swapped</span>
                  <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{swapInAmount} {swapInToken}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--text3)' }}>Received</span>
                  <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{amount} {token}</span>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--text3)' }}>Recipient</span>
                  <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{formatAddress(recipient)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--text3)' }}>Amount</span>
                  <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{amount} {token}</span>
                </div>
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: 'var(--text3)' }}>Settlement Network</span>
              <span style={{ color: 'var(--text2)', fontWeight: 600 }}>Arc Testnet</span>
            </div>
            {txHash && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                <span style={{ color: 'var(--text3)' }}>TX Hash</span>
                <span style={{ color: 'var(--text2)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: 'monospace' }}>{formatAddress(txHash)}</span>
                  <button 
                    onClick={copyHash} 
                    style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', display: 'flex', padding: 2 }}
                    title="Copy Transaction Hash"
                  >
                    {copied ? <Check size={12} style={{ color: 'var(--green)' }} /> : <Copy size={12} />}
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Action button group */}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'stretch' }}>
          {onSendAnother ? (
            <button
              onClick={onSendAnother}
              className="btn btn-secondary btn-sm"
              style={{ flex: 1 }}
            >
              {repeatLabel || 'Send Another'}
            </button>
          ) : explorerUrl ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary btn-sm"
              style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              <span>View TX</span>
              <ExternalLink size={14} />
            </a>
          ) : (
            <Link to="/" className="btn btn-secondary btn-sm" style={{ flex: 1 }}>Go Home</Link>
          )}

          <button onClick={onClose} className="btn btn-primary btn-sm" style={{ flex: 1 }}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
