import { ArrowDownUp, ChevronDown, X } from 'lucide-react'
import PinDotsInput from '../../components/PinDotsInput'
import { CAVO_SECURITY_QUESTIONS } from '../../lib/config'
import type { SwapQuote } from '../../lib/api'

export type SwapToken = 'USDC' | 'EURC'
export type SwapStep = 'details' | 'pin' | 'processing'

type SwapModalProps = {
  swapStep: SwapStep
  swapAmount: string
  swapTokenIn: SwapToken
  swapQuote: SwapQuote | null
  quoteLoading: boolean
  quoteError: string | null
  swapError: string | null
  isSwapping: boolean
  cavoPin: string
  confirmPin: string
  securityAnswerOne: string
  securityAnswerTwo: string
  hasCavoPin: boolean | null
  walletAddress: string
  usdcBalance: string
  eurcBalance: string
  onAmountChange: (value: string) => void
  onTokenInChange: (value: SwapToken) => void
  onCavoPinChange: (value: string) => void
  onConfirmPinChange: (value: string) => void
  onSecurityAnswerOneChange: (value: string) => void
  onSecurityAnswerTwoChange: (value: string) => void
  onReview: () => void
  onSubmitPin: () => void
  onBackToDetails: () => void
  onClose: () => void
  shortenAddress: (address: string) => string
}

const TOKEN_META: Record<SwapToken, { logo: string }> = {
  USDC: { logo: '/usdc-logo.png' },
  EURC: { logo: '/eurc-logo.png' },
}

const C = {
  card: '#FFFFFF',
  canvas: '#F6F7F6',
  accent: '#0E6B4E',
  accentHover: '#0A5740',
  accentTint: '#EAF3EF',
  text: '#14201B',
  text2: '#5B6B63',
  text3: '#93A29A',
  border: '#E4E9E6',
  borderStrong: '#D4DDD9',
  red: '#B3362B',
}

function TokenSelector({
  token,
  disabled,
  onSelect,
}: {
  token: SwapToken
  disabled?: boolean
  onSelect: (token: SwapToken) => void
}) {
  const meta = TOKEN_META[token]
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(token === 'USDC' ? 'EURC' : 'USDC')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: '8px 12px',
        color: C.text,
        fontSize: 15,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <img
        src={meta.logo}
        alt={token}
        style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0 }}
      />
      {token}
      <ChevronDown size={14} color={C.text2} />
    </button>
  )
}

function AmountDisplay({
  value,
  placeholder,
  isInput,
  onChange,
  disabled,
}: {
  value: string
  placeholder: string
  isInput?: boolean
  onChange?: (value: string) => void
  disabled?: boolean
}) {
  const usdValue = Number(value)
  const usdText = Number.isFinite(usdValue) && usdValue > 0
    ? `$${usdValue.toFixed(2)}`
    : '$0.00'
  return (
    <div style={{ textAlign: 'right' }}>
      {isInput ? (
        <input
          type="number"
          value={value}
          onChange={event => onChange?.(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: C.text,
            fontSize: 28,
            fontWeight: 700,
            textAlign: 'right',
            width: 140,
            padding: 0,
          }}
        />
      ) : (
        <div style={{ color: C.text, fontSize: 28, fontWeight: 700 }}>{value || placeholder}</div>
      )}
      <div style={{ color: C.text2, fontSize: 13, marginTop: 2 }}>{usdText}</div>
    </div>
  )
}

export default function SwapModal({
  swapStep,
  swapAmount,
  swapTokenIn,
  swapQuote,
  quoteLoading,
  quoteError,
  swapError,
  isSwapping,
  cavoPin,
  confirmPin,
  securityAnswerOne,
  securityAnswerTwo,
  hasCavoPin,
  walletAddress,
  usdcBalance,
  eurcBalance,
  onAmountChange,
  onTokenInChange,
  onCavoPinChange,
  onConfirmPinChange,
  onSecurityAnswerOneChange,
  onSecurityAnswerTwoChange,
  onReview,
  onSubmitPin,
  onBackToDetails,
  onClose,
  shortenAddress,
}: SwapModalProps) {
  const tokenOut: SwapToken = swapTokenIn === 'USDC' ? 'EURC' : 'USDC'
  const isCreatingPin = !hasCavoPin
  const amountNumber = Number(swapAmount)
  const canReview = Number.isFinite(amountNumber) && amountNumber > 0 && !!walletAddress
  const canSubmitPin = cavoPin.length === 4 && (
    hasCavoPin || (confirmPin.length === 4 && securityAnswerOne.trim() && securityAnswerTwo.trim())
  )

  const sellBalance = swapTokenIn === 'USDC' ? usdcBalance : eurcBalance
  const receiveBalance = tokenOut === 'USDC' ? usdcBalance : eurcBalance
  const sellBalanceNum = Number(sellBalance) || 0

  const setPercent = (pct: number) => {
    const amount = (sellBalanceNum * pct).toFixed(6)
    onAmountChange(amount)
  }

  const rateText = swapQuote
    ? `1 ${swapQuote.tokenIn} = ${(Number(swapQuote.estimatedOutput) / Number(swapQuote.amountIn)).toFixed(6)} ${swapQuote.tokenOut}`
    : '—'

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(20, 32, 27, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          background: C.card,
          borderRadius: 16,
          padding: 20,
          width: '100%',
          maxWidth: 400,
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(20, 32, 27, 0.15)',
          border: `1px solid ${C.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <button className="icon-btn" onClick={onClose} aria-label="Close swap">
            <X size={20} color={C.text} />
          </button>
        </div>

        {swapStep === 'details' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Sell section */}
            <div style={{ background: C.canvas, borderRadius: 12, padding: 16, border: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ color: C.text2, fontSize: 14 }}>Sell</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: C.text2, fontSize: 13 }}>{sellBalance} {swapTokenIn}</span>
                  <button
                    type="button"
                    onClick={() => setPercent(0.5)}
                    style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text2, fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}
                  >
                    50%
                  </button>
                  <button
                    type="button"
                    onClick={() => setPercent(1)}
                    style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text2, fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}
                  >
                    Max
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <TokenSelector token={swapTokenIn} onSelect={onTokenInChange} />
                <AmountDisplay
                  value={swapAmount}
                  placeholder="0.00"
                  isInput
                  onChange={onAmountChange}
                />
              </div>
            </div>

            {/* Flip button */}
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button
                type="button"
                onClick={() => onTokenInChange(tokenOut)}
                aria-label="Flip swap direction"
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <ArrowDownUp size={18} color={C.accent} />
              </button>
            </div>

            {/* Receive section */}
            <div style={{ background: C.canvas, borderRadius: 12, padding: 16, border: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ color: C.text2, fontSize: 14 }}>Receive</span>
                <span style={{ color: C.text2, fontSize: 13 }}>{receiveBalance} {tokenOut}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <TokenSelector token={tokenOut} onSelect={onTokenInChange} />
                <AmountDisplay
                  value={quoteLoading ? '' : (swapQuote?.estimatedOutput || '')}
                  placeholder="0.00"
                />
              </div>
            </div>

            {/* Rate */}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 4px' }}>
              <span style={{ color: C.text2, fontSize: 13 }}>Rate</span>
              <span style={{ color: C.text, fontSize: 13 }}>
                {quoteLoading ? 'Fetching...' : rateText}
              </span>
            </div>

            {quoteError && <div style={{ color: C.red, fontSize: 13 }}>{quoteError}</div>}
            {swapError && <div style={{ color: C.red, fontSize: 13 }}>{swapError}</div>}

            <button
              onClick={onReview}
              disabled={!canReview || quoteLoading || !swapQuote}
              style={{
                background: canReview && !quoteLoading && swapQuote ? C.accent : C.border,
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '14px',
                fontSize: 16,
                fontWeight: 600,
                cursor: canReview && !quoteLoading && swapQuote ? 'pointer' : 'not-allowed',
                opacity: canReview && !quoteLoading && swapQuote ? 1 : 0.6,
              }}
            >
              Continue
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {swapQuote && (
              <div style={{ background: C.canvas, borderRadius: 12, padding: 16, border: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: C.text2, fontSize: 14 }}>You pay</span>
                  <strong style={{ color: C.text, fontSize: 14 }}>{swapQuote.amountIn} {swapQuote.tokenIn}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: C.text2, fontSize: 14 }}>You receive</span>
                  <strong style={{ color: C.text, fontSize: 14 }}>≈ {swapQuote.estimatedOutput} {swapQuote.tokenOut}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: C.text2, fontSize: 14 }}>Minimum received</span>
                  <strong style={{ color: C.text, fontSize: 14 }}>{swapQuote.minOut} {swapQuote.tokenOut}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: C.text2, fontSize: 14 }}>Your wallet</span>
                  <strong style={{ color: C.text, fontSize: 14 }}>{shortenAddress(walletAddress)}</strong>
                </div>
              </div>
            )}

            {swapStep === 'processing' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '20px 0' }}>
                <div style={{ width: 32, height: 32, border: `3px solid ${C.border}`, borderTopColor: C.accent, borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                <div>
                  <strong style={{ color: C.text, display: 'block' }}>Swap submitted</strong>
                  <span style={{ color: C.text2, fontSize: 13 }}>Waiting for network confirmation...</span>
                </div>
              </div>
            ) : (
              <>
                <PinDotsInput
                  label={hasCavoPin ? 'Payment PIN' : 'New Payment PIN'}
                  value={cavoPin}
                  onChange={onCavoPinChange}
                  disabled={isSwapping}
                />

                {isCreatingPin && (
                  <>
                    <PinDotsInput
                      label="Confirm PIN"
                      value={confirmPin}
                      onChange={onConfirmPinChange}
                      disabled={isSwapping}
                    />
                    <div>
                      <label style={{ color: C.text2, fontSize: 13, display: 'block', marginBottom: 6 }}>{CAVO_SECURITY_QUESTIONS[0]}</label>
                      <input
                        placeholder="Your answer"
                        value={securityAnswerOne}
                        onChange={event => onSecurityAnswerOneChange(event.target.value)}
                        disabled={isSwapping}
                        style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '10px 12px', fontSize: 14, outline: 'none' }}
                      />
                    </div>
                    <div>
                      <label style={{ color: C.text2, fontSize: 13, display: 'block', marginBottom: 6 }}>{CAVO_SECURITY_QUESTIONS[1]}</label>
                      <input
                        placeholder="Answer"
                        value={securityAnswerTwo}
                        onChange={event => onSecurityAnswerTwoChange(event.target.value)}
                        disabled={isSwapping}
                        style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '10px 12px', fontSize: 14, outline: 'none' }}
                      />
                    </div>
                  </>
                )}

                {swapError && <div style={{ color: C.red, fontSize: 13 }}>{swapError}</div>}

                <button
                  onClick={onSubmitPin}
                  disabled={isSwapping || !canSubmitPin}
                  style={{
                    background: !isSwapping && canSubmitPin ? C.accent : C.border,
                    color: '#fff',
                    border: 'none',
                    borderRadius: 10,
                    padding: '14px',
                    fontSize: 16,
                    fontWeight: 600,
                    cursor: !isSwapping && canSubmitPin ? 'pointer' : 'not-allowed',
                    opacity: !isSwapping && canSubmitPin ? 1 : 0.6,
                  }}
                >
                  {isSwapping ? 'Swapping...' : hasCavoPin ? 'Approve and Swap' : 'Create PIN and Swap'}
                </button>
                <button
                  onClick={onBackToDetails}
                  disabled={isSwapping}
                  style={{ background: 'transparent', color: C.text2, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px', fontSize: 14, cursor: 'pointer' }}
                >
                  Back
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
