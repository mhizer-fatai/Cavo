import { X } from 'lucide-react'
import PinDotsInput from '../../components/PinDotsInput'
import { CAVO_SECURITY_QUESTIONS, CCTP_WITHDRAW_CHAINS, isValidWithdrawAddress } from '../../lib/config'

export type WithdrawStep = 'details' | 'pin' | 'processing'

type WithdrawModalProps = {
  withdrawStep: WithdrawStep
  withdrawAddress: string
  withdrawChain: string
  withdrawAmount: string
  withdrawError: string | null
  isWithdrawing: boolean
  cavoPin: string
  confirmPin: string
  securityAnswerOne: string
  securityAnswerTwo: string
  hasCavoPin: boolean | null
  walletAddress: string
  availableBalance: string
  onAddressChange: (value: string) => void
  onChainChange: (value: string) => void
  onAmountChange: (value: string) => void
  onCavoPinChange: (value: string) => void
  onConfirmPinChange: (value: string) => void
  onSecurityAnswerOneChange: (value: string) => void
  onSecurityAnswerTwoChange: (value: string) => void
  onReview: () => void
  onSubmitPin: () => void
  onBackToDetails: () => void
  onClose: () => void
  getChainLabel: (value?: string) => string
  shortenAddress: (address: string) => string
}

export default function WithdrawModal({
  withdrawStep,
  withdrawAddress,
  withdrawChain,
  withdrawAmount,
  withdrawError,
  isWithdrawing,
  cavoPin,
  confirmPin,
  securityAnswerOne,
  securityAnswerTwo,
  hasCavoPin,
  walletAddress,
  availableBalance,
  onAddressChange,
  onChainChange,
  onAmountChange,
  onCavoPinChange,
  onConfirmPinChange,
  onSecurityAnswerOneChange,
  onSecurityAnswerTwoChange,
  onReview,
  onSubmitPin,
  onBackToDetails,
  onClose,
  getChainLabel,
  shortenAddress,
}: WithdrawModalProps) {
  const isCreatingPin = !hasCavoPin
  const canSubmitPin = cavoPin.length === 4 && (
    hasCavoPin || (confirmPin.length === 4 && securityAnswerOne.trim() && securityAnswerTwo.trim())
  )
  const amountNumber = Number(withdrawAmount)
  const balanceNumber = Number(availableBalance)
  const addressOk = isValidWithdrawAddress(withdrawChain, withdrawAddress)
  const isSolana = CCTP_WITHDRAW_CHAINS.find(chain => chain.value === withdrawChain)?.addressKind === 'solana'
  const isCrossChain = withdrawChain !== 'Arc_Testnet'
  const canReview = withdrawAddress.trim() && addressOk
    && Number.isFinite(amountNumber) && amountNumber > 0
    && Number.isFinite(balanceNumber) && amountNumber <= balanceNumber
    && !!walletAddress

  return (
    <div className="wc-modal" onClick={onClose}>
      <div className="card glass wc-card send-card" onClick={event => event.stopPropagation()}>
        <div className="wc-title modal-title-row">
          {withdrawStep === 'details' ? 'Withdraw' : withdrawStep === 'processing' ? 'Withdrawal Submitted' : hasCavoPin ? 'Enter Payment PIN' : 'Create Payment PIN'}
          <button className="icon-btn" onClick={onClose} aria-label="Close withdraw">
            <X size={20} />
          </button>
        </div>
        <div className="wc-sub">
          {withdrawStep === 'details'
            ? 'Withdraw USDC to any address on Arc or any CCTP-supported chain.'
            : withdrawStep === 'processing'
              ? 'Your withdrawal is on its way. The receipt will appear after network confirmation.'
              : hasCavoPin
                ? 'Approve this exact withdrawal. Your PIN is verified securely by Cavo.'
                : 'Create a 4-digit Payment PIN. You will use it to approve everyday actions.'}
        </div>

        {withdrawStep === 'details' ? (
          <div className="form-stack">
            <div className="form-group">
              <label className="form-label">Destination chain</label>
              <select
                value={withdrawChain}
                onChange={(event) => onChainChange(event.target.value)}
                className="form-input"
              >
                {CCTP_WITHDRAW_CHAINS.map(chain => (
                  <option key={chain.value} value={chain.value}>{chain.label}</option>
                ))}
              </select>
              <div className="muted-small" style={{ marginTop: 6 }}>
                {isCrossChain
                  ? 'Bridged via Circle CCTP and settles in seconds.'
                  : 'Settles on Arc Testnet in seconds.'}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Destination address</label>
              <input
                type="text"
                value={withdrawAddress}
                onChange={(event) => onAddressChange(event.target.value)}
                placeholder={isSolana ? 'Solana address (base58)' : '0x address'}
                className="form-input"
                style={{ fontFamily: 'monospace', fontSize: 13 }}
              />
              {withdrawAddress.trim() && !addressOk && (
                <p style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>
                  {isSolana ? 'Enter a valid Solana address.' : 'Enter a valid 0x address.'}
                </p>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">Amount (USDC)</label>
              <input
                type="number"
                value={withdrawAmount}
                onChange={(event) => onAmountChange(event.target.value)}
                placeholder="0.00"
                className="form-input"
              />
              <div className="muted-small" style={{ marginTop: 6 }}>
                Available: {availableBalance} USDC · CCTP moves USDC only
              </div>
            </div>

            {withdrawError && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 4 }}>{withdrawError}</div>}

            <button onClick={onReview} disabled={!canReview || isWithdrawing} className="btn btn-primary btn-full send-submit-btn">
              Continue
            </button>
          </div>
        ) : (
          <div className="form-stack">
            <div className="pin-summary">
              <div className="pin-summary-row">
                <span>To</span>
                <strong>{shortenAddress(withdrawAddress)}</strong>
              </div>
              <div className="pin-summary-row">
                <span>Amount</span>
                <strong>{withdrawAmount} USDC</strong>
              </div>
              <div className="pin-summary-row">
                <span>Chain</span>
                <strong>{getChainLabel(withdrawChain)}{isCrossChain ? ' · via CCTP' : ''}</strong>
              </div>
              <div className="pin-summary-row">
                <span>Your wallet</span>
                <strong>{shortenAddress(walletAddress)}</strong>
              </div>
            </div>

            {withdrawStep === 'processing' ? (
              <div className="pin-progress">
                <div className="pin-progress-ring">
                  <div className="loader" />
                </div>
                <div>
                  <strong>Withdrawal submitted</strong>
                  <span>Waiting for network confirmation...</span>
                </div>
              </div>
            ) : (
              <>
                <PinDotsInput
                  label={hasCavoPin ? 'Payment PIN' : 'New Payment PIN'}
                  value={cavoPin}
                  onChange={onCavoPinChange}
                  disabled={isWithdrawing}
                />

                {isCreatingPin && (
                  <>
                    <PinDotsInput
                      label="Confirm PIN"
                      value={confirmPin}
                      onChange={onConfirmPinChange}
                      disabled={isWithdrawing}
                    />
                    <div className="form-group">
                      <label className="form-label">{CAVO_SECURITY_QUESTIONS[0]}</label>
                      <input
                        className="form-input"
                        placeholder="Your answer"
                        value={securityAnswerOne}
                        onChange={event => onSecurityAnswerOneChange(event.target.value)}
                        disabled={isWithdrawing}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{CAVO_SECURITY_QUESTIONS[1]}</label>
                      <input
                        className="form-input"
                        placeholder="Answer"
                        value={securityAnswerTwo}
                        onChange={event => onSecurityAnswerTwoChange(event.target.value)}
                        disabled={isWithdrawing}
                      />
                    </div>
                  </>
                )}

                {withdrawError && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 4 }}>{withdrawError}</div>}

                <button
                  onClick={onSubmitPin}
                  disabled={isWithdrawing || !canSubmitPin}
                  className="btn btn-primary btn-full send-submit-btn"
                >
                  {isWithdrawing ? 'Withdrawing...' : hasCavoPin ? 'Approve and Withdraw' : 'Create PIN and Withdraw'}
                </button>
                <button onClick={onBackToDetails} disabled={isWithdrawing} className="btn btn-secondary btn-full">
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
