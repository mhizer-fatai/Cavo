import { ArrowDownUp, X } from 'lucide-react'
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

function SwapTokenPill({
  symbol,
  active,
  disabled,
  onSelect,
}: {
  symbol: SwapToken
  active: boolean
  disabled?: boolean
  onSelect: (symbol: SwapToken) => void
}) {
  return (
    <button
      type="button"
      className={`token-pill ${active ? 'active' : ''}`}
      onClick={() => onSelect(symbol)}
      disabled={disabled}
    >
      {symbol}
    </button>
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
  const title = swapStep === 'details'
    ? 'Swap Stablecoins'
    : swapStep === 'processing'
      ? 'Swap Submitted'
      : hasCavoPin ? 'Enter Payment PIN' : 'Create Payment PIN'

  return (
    <div className="wc-modal" onClick={onClose}>
      <div className="card glass wc-card send-card" onClick={event => event.stopPropagation()}>
        <div className="wc-title modal-title-row">
          {title}
          <button className="icon-btn" onClick={onClose} aria-label="Close swap">
            <X size={20} />
          </button>
        </div>
        <div className="wc-sub">
          {swapStep === 'details'
            ? 'Convert between USDC and EURC instantly inside your Cavo wallet.'
            : swapStep === 'processing'
              ? 'Your swap is on its way. The receipt will appear after network confirmation.'
              : hasCavoPin
                ? 'Approve this exact swap. Your PIN is verified securely by Cavo.'
                : 'Create a 4-digit Payment PIN. You will use it to approve everyday actions.'}
        </div>

        {swapStep === 'details' ? (
          <div className="form-stack">
            <div className="form-group">
              <label className="form-label">You pay</label>
              <div className="amount-input-wrapper">
                <input
                  type="number"
                  value={swapAmount}
                  onChange={event => onAmountChange(event.target.value)}
                  placeholder="0.00"
                  className="amount-field"
                />
              </div>
              <div className="token-select-pills">
                <SwapTokenPill symbol="USDC" active={swapTokenIn === 'USDC'} onSelect={onTokenInChange} />
                <SwapTokenPill symbol="EURC" active={swapTokenIn === 'EURC'} onSelect={onTokenInChange} />
              </div>
            </div>

            <div className="swap-direction-row">
              <button
                type="button"
                className="icon-btn swap-flip-btn"
                onClick={() => onTokenInChange(tokenOut)}
                aria-label="Flip swap direction"
              >
                <ArrowDownUp size={16} />
              </button>
              <span className="muted-small">You receive {tokenOut}</span>
            </div>

            <div className="pin-summary">
              <div className="pin-summary-row">
                <span>Rate</span>
                <strong>
                  {quoteLoading
                    ? 'Fetching...'
                    : swapQuote
                      ? `1 ${swapQuote.tokenIn} ≈ ${(
                          Number(swapQuote.estimatedOutput) / Number(swapQuote.amountIn)
                        ).toFixed(6)} ${swapQuote.tokenOut}`
                      : '—'}
                </strong>
              </div>
              <div className="pin-summary-row">
                <span>Estimated output</span>
                <strong>
                  {quoteLoading ? 'Fetching...' : swapQuote ? `${swapQuote.estimatedOutput} ${tokenOut}` : '—'}
                </strong>
              </div>
              <div className="pin-summary-row">
                <span>Minimum received</span>
                <strong>{swapQuote ? `${swapQuote.minOut} ${tokenOut}` : '—'}</strong>
              </div>
              <div className="pin-summary-row">
                <span>Liquidity</span>
                <strong>{swapQuote ? swapQuote.provider : '—'}</strong>
              </div>
            </div>

            {quoteError && <div className="error-text">{quoteError}</div>}
            {swapError && <div className="error-text">{swapError}</div>}

            <button
              onClick={onReview}
              disabled={!canReview || quoteLoading || !swapQuote}
              className="btn btn-primary btn-full send-submit-btn"
            >
              Continue
            </button>
          </div>
        ) : (
          <div className="form-stack">
            {swapQuote && (
              <div className="pin-summary">
                <div className="pin-summary-row">
                  <span>You pay</span>
                  <strong>{swapQuote.amountIn} {swapQuote.tokenIn}</strong>
                </div>
                <div className="pin-summary-row">
                  <span>You receive</span>
                  <strong>≈ {swapQuote.estimatedOutput} {swapQuote.tokenOut}</strong>
                </div>
                <div className="pin-summary-row">
                  <span>Minimum received</span>
                  <strong>{swapQuote.minOut} {swapQuote.tokenOut}</strong>
                </div>
                <div className="pin-summary-row">
                  <span>Your wallet</span>
                  <strong>{shortenAddress(walletAddress)}</strong>
                </div>
              </div>
            )}

            {swapStep === 'processing' ? (
              <div className="pin-progress">
                <div className="pin-progress-ring">
                  <div className="loader" />
                </div>
                <div>
                  <strong>Swap submitted</strong>
                  <span>Waiting for network confirmation...</span>
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
                    <div className="form-group">
                      <label className="form-label">{CAVO_SECURITY_QUESTIONS[0]}</label>
                      <input
                        className="form-input"
                        placeholder="Your answer"
                        value={securityAnswerOne}
                        onChange={event => onSecurityAnswerOneChange(event.target.value)}
                        disabled={isSwapping}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{CAVO_SECURITY_QUESTIONS[1]}</label>
                      <input
                        className="form-input"
                        placeholder="Answer"
                        value={securityAnswerTwo}
                        onChange={event => onSecurityAnswerTwoChange(event.target.value)}
                        disabled={isSwapping}
                      />
                    </div>
                  </>
                )}

                {swapError && <div className="error-text">{swapError}</div>}

                <button
                  onClick={onSubmitPin}
                  disabled={isSwapping || !canSubmitPin}
                  className="btn btn-primary btn-full send-submit-btn"
                >
                  {isSwapping ? 'Swapping...' : hasCavoPin ? 'Approve and Swap' : 'Create PIN and Swap'}
                </button>
                <button onClick={onBackToDetails} disabled={isSwapping} className="btn btn-secondary btn-full">
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
