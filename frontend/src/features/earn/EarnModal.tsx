import { PiggyBank, X } from 'lucide-react'
import PinDotsInput from '../../components/PinDotsInput'
import { CAVOPAY_SECURITY_QUESTIONS } from '../../lib/config'
import type { EarnVault } from '../../lib/api'

export type EarnToken = 'USDC' | 'EURC'
export type EarnMode = 'deposit' | 'withdraw'
export type EarnStep = 'details' | 'pin' | 'processing'

type EarnModalProps = {
  mode: EarnMode
  earnStep: EarnStep
  earnAmount: string
  earnToken: EarnToken
  vaults: EarnVault[]
  earnError: string | null
  isEarning: boolean
  cavopayPin: string
  confirmPin: string
  securityAnswerOne: string
  securityAnswerTwo: string
  hasCavopayPin: boolean | null
  walletAddress: string
  availableBalance: string
  positionShares: number
  onAmountChange: (value: string) => void
  onTokenChange: (token: EarnToken) => void
  onModeChange: (mode: EarnMode) => void
  onCavopayPinChange: (value: string) => void
  onConfirmPinChange: (value: string) => void
  onSecurityAnswerOneChange: (value: string) => void
  onSecurityAnswerTwoChange: (value: string) => void
  onReview: () => void
  onSubmitPin: () => void
  onBackToDetails: () => void
  onClose: () => void
  shortenAddress: (address: string) => string
}

function EarnTokenPill({
  symbol,
  active,
  disabled,
  onSelect,
}: {
  symbol: EarnToken
  active: boolean
  disabled?: boolean
  onSelect: (symbol: EarnToken) => void
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

export default function EarnModal({
  mode,
  earnStep,
  earnAmount,
  earnToken,
  vaults,
  earnError,
  isEarning,
  cavopayPin,
  confirmPin,
  securityAnswerOne,
  securityAnswerTwo,
  hasCavopayPin,
  walletAddress,
  availableBalance,
  positionShares,
  onAmountChange,
  onTokenChange,
  onModeChange,
  onCavopayPinChange,
  onConfirmPinChange,
  onSecurityAnswerOneChange,
  onSecurityAnswerTwoChange,
  onReview,
  onSubmitPin,
  onBackToDetails,
  onClose,
  shortenAddress,
}: EarnModalProps) {
  const vault = vaults.find(item => item.token === earnToken)
  const shareSymbol = mode === 'deposit'
    ? earnToken === 'USDC' ? 'alvUSDC' : 'alvEURC'
    : earnToken
  const isCreatingPin = !hasCavopayPin
  const amountNumber = Number(earnAmount)
  const sharePrice = vault?.sharePrice && vault.sharePrice > 0 ? vault.sharePrice : 1
  const estimatedShares = mode === 'deposit'
    ? (Number.isFinite(amountNumber) ? amountNumber / sharePrice : 0)
    : 0
  const estimatedAssets = mode === 'withdraw'
    ? (Number.isFinite(amountNumber) ? amountNumber * sharePrice : 0)
    : 0
  const maxDeposit = vault?.maxDeposit
  const depositsBlocked = mode === 'deposit' && maxDeposit != null && maxDeposit <= 0
  // Earn exits always settle to the dashboard (Arc) balance; cross-chain moves
  // happen from there via Send, which already has a destination chain selector.
  const balanceNumber = Number(availableBalance)
  const overBalance = mode === 'deposit'
    && Number.isFinite(amountNumber) && Number.isFinite(balanceNumber)
    && amountNumber > balanceNumber
  const overShares = mode === 'withdraw'
    && Number.isFinite(amountNumber) && amountNumber > positionShares
  const canReview = Number.isFinite(amountNumber) && amountNumber > 0
    && !!walletAddress && !overBalance && !overShares && !depositsBlocked
  const canSubmitPin = cavopayPin.length === 4 && (
    hasCavopayPin || (confirmPin.length === 4 && securityAnswerOne.trim() && securityAnswerTwo.trim())
  )
  const title = earnStep === 'details'
    ? mode === 'deposit' ? 'Deposit to Earn' : 'Withdraw from Earn'
    : earnStep === 'processing'
      ? mode === 'deposit' ? 'Deposit Submitted' : 'Withdrawal Submitted'
      : hasCavopayPin ? 'Enter Payment PIN' : 'Create Payment PIN'
  const apyLabel = vault?.apy != null
    ? `${(vault.apy * 100).toFixed(2)}% APY`
    : 'APY calibrating…'

  return (
    <div className="wc-modal" onClick={onClose}>
      <div className="card glass wc-card send-card" onClick={event => event.stopPropagation()}>
        <div className="wc-title modal-title-row">
          {title}
          <button className="icon-btn" onClick={onClose} aria-label="Close earn">
            <X size={20} />
          </button>
        </div>
        <div className="wc-sub">
          {earnStep === 'details'
            ? mode === 'deposit'
              ? 'Put idle stablecoins into ArcLend vaults and earn yield as shares appreciate.'
              : 'Burn vault shares and get your stablecoins back plus accrued yield.'
            : earnStep === 'processing'
              ? 'Your earn transaction is on its way. The receipt will appear after network confirmation.'
              : hasCavopayPin
                ? 'Approve this exact earn transaction. Your PIN is verified securely by Cavopay.'
                : 'Create a 4-digit Payment PIN. You will use it to approve everyday actions.'}
        </div>

        <div className="token-select-pills" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={`token-pill ${mode === 'deposit' ? 'active' : ''}`}
            onClick={() => onModeChange('deposit')}
          >
            Deposit
          </button>
          <button
            type="button"
            className={`token-pill ${mode === 'withdraw' ? 'active' : ''}`}
            onClick={() => onModeChange('withdraw')}
          >
            Withdraw
          </button>
        </div>

        {earnStep === 'details' ? (
          <div className="form-stack">
            <div className="form-group">
              <label className="form-label">{mode === 'deposit' ? 'You deposit' : 'Shares to burn'}</label>
              <div className="amount-input-wrapper">
                <input
                  type="number"
                  value={earnAmount}
                  onChange={event => onAmountChange(event.target.value)}
                  placeholder="0.00"
                  className="amount-field"
                />
              </div>
              <div className="token-select-pills">
                <EarnTokenPill symbol="USDC" active={earnToken === 'USDC'} onSelect={onTokenChange} />
                <EarnTokenPill symbol="EURC" active={earnToken === 'EURC'} onSelect={onTokenChange} />
              </div>
              <div className="muted-small" style={{ marginTop: 6 }}>
                {mode === 'deposit'
                  ? `Available: ${availableBalance} ${earnToken}`
                  : `Your shares: ${positionShares.toFixed(6)} ${vault?.id || ''}`}
              </div>
            </div>

            {mode === 'withdraw' && (
              <div className="form-group">
                <label className="form-label">Withdraw to</label>
                <div className="pin-summary">
                  <div className="pin-summary-row">
                    <span>Destination</span>
                    <strong>Dashboard balance · Arc Testnet</strong>
                  </div>
                </div>
                <div className="muted-small" style={{ marginTop: 6 }}>
                  Earn withdrawals always settle to your dashboard balance in seconds. To move funds cross-chain, use Send afterwards.
                </div>
              </div>
            )}

            <div className="pin-summary">
              <div className="pin-summary-row">
                <span>Vault</span>
                <strong>{vault ? `${vault.id} · ${vault.provider}` : '—'}</strong>
              </div>
              <div className="pin-summary-row">
                <span>Yield</span>
                <strong>{apyLabel}</strong>
              </div>
              <div className="pin-summary-row">
                <span>{mode === 'deposit' ? 'You receive (est.)' : 'You receive (est.)'}</span>
                <strong>
                  {mode === 'deposit'
                    ? `≈ ${estimatedShares.toFixed(6)} ${shareSymbol}`
                    : `≈ ${estimatedAssets.toFixed(6)} ${earnToken}`}
                </strong>
              </div>
              <div className="pin-summary-row">
                <span>Vault TVL</span>
                <strong>{vault ? `${vault.totalAssets.toFixed(2)} ${earnToken}` : '—'}</strong>
              </div>
            </div>

            <div className="muted-small" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <PiggyBank size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>Experimental testnet vault (unaudited community contract). Capped at 100 {earnToken} per transaction.</span>
            </div>

            {depositsBlocked && (
              <div className="error-text">This vault is not accepting deposits right now (max deposit is 0). Try again later.</div>
            )}
            {overBalance && <div className="error-text">Amount exceeds your available {earnToken} balance.</div>}
            {overShares && <div className="error-text">Amount exceeds your vault share balance.</div>}
            {earnError && <div className="error-text">{earnError}</div>}

            <button
              onClick={onReview}
              disabled={!canReview}
              className="btn btn-primary btn-full send-submit-btn"
            >
              Continue
            </button>
          </div>
        ) : (
          <div className="form-stack">
            <div className="pin-summary">
              <div className="pin-summary-row">
                <span>{mode === 'deposit' ? 'You deposit' : 'You burn'}</span>
                <strong>{earnAmount} {mode === 'deposit' ? earnToken : shareSymbol}</strong>
              </div>
              <div className="pin-summary-row">
                <span>You receive (est.)</span>
                <strong>
                  {mode === 'deposit'
                    ? `≈ ${estimatedShares.toFixed(6)} ${shareSymbol}`
                    : `≈ ${estimatedAssets.toFixed(6)} ${earnToken}`}
                </strong>
              </div>
              <div className="pin-summary-row">
                <span>Vault</span>
                <strong>{vault?.id || '—'}</strong>
              </div>
              {mode === 'withdraw' && (
                <div className="pin-summary-row">
                  <span>Destination</span>
                  <strong>Dashboard balance · Arc Testnet</strong>
                </div>
              )}
              <div className="pin-summary-row">
                <span>Your wallet</span>
                <strong>{shortenAddress(walletAddress)}</strong>
              </div>
            </div>

            {earnStep === 'processing' ? (
              <div className="pin-progress">
                <div className="pin-progress-ring">
                  <div className="loader" />
                </div>
                <div>
                  <strong>{mode === 'deposit' ? 'Deposit submitted' : 'Withdrawal submitted'}</strong>
                  <span>Waiting for network confirmation...</span>
                </div>
              </div>
            ) : (
              <>
                <PinDotsInput
                  label={hasCavopayPin ? 'Payment PIN' : 'New Payment PIN'}
                  value={cavopayPin}
                  onChange={onCavopayPinChange}
                  disabled={isEarning}
                />

                {isCreatingPin && (
                  <>
                    <PinDotsInput
                      label="Confirm PIN"
                      value={confirmPin}
                      onChange={onConfirmPinChange}
                      disabled={isEarning}
                    />
                    <div className="form-group">
                      <label className="form-label">{CAVOPAY_SECURITY_QUESTIONS[0]}</label>
                      <input
                        className="form-input"
                        placeholder="Your answer"
                        value={securityAnswerOne}
                        onChange={event => onSecurityAnswerOneChange(event.target.value)}
                        disabled={isEarning}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{CAVOPAY_SECURITY_QUESTIONS[1]}</label>
                      <input
                        className="form-input"
                        placeholder="Answer"
                        value={securityAnswerTwo}
                        onChange={event => onSecurityAnswerTwoChange(event.target.value)}
                        disabled={isEarning}
                      />
                    </div>
                  </>
                )}

                {earnError && <div className="error-text">{earnError}</div>}

                <button
                  onClick={onSubmitPin}
                  disabled={isEarning || !canSubmitPin}
                  className="btn btn-primary btn-full send-submit-btn"
                >
                  {isEarning
                    ? mode === 'deposit' ? 'Depositing...' : 'Withdrawing...'
                    : hasCavopayPin
                      ? mode === 'deposit' ? 'Approve and Deposit' : 'Approve and Withdraw'
                      : mode === 'deposit' ? 'Create PIN and Deposit' : 'Create PIN and Withdraw'}
                </button>
                <button onClick={onBackToDetails} disabled={isEarning} className="btn btn-secondary btn-full">
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
