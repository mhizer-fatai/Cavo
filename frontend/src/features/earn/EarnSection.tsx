import { ArrowDownToLine, ArrowUpFromLine, FlaskConical, PiggyBank } from 'lucide-react'
import type { EarnPosition, EarnVault } from '../../lib/api'
import type { EarnToken } from './EarnModal'

type EarnSectionProps = {
  vaults: EarnVault[]
  positions: EarnPosition[]
  loading: boolean
  onDeposit: (token: EarnToken) => void
  onWithdraw: (token: EarnToken) => void
}

function formatApy(vault: EarnVault): string {
  if (vault.apy == null) return 'APY calibrating…'
  return `${(vault.apy * 100).toFixed(2)}% APY`
}

export default function EarnSection({ vaults, positions, loading, onDeposit, onWithdraw }: EarnSectionProps) {
  const positionByToken = new Map(positions.map(position => [String(position.token).toUpperCase(), position]))
  const totalValue = positions.reduce((sum, position) => sum + (Number(position.currentValue) || 0), 0)
  const totalEarnings = positions.reduce((sum, position) => sum + (Number(position.earnings) || 0), 0)

  return (
    <div className="card glass earn-section">
      <div className="earn-heading">
        <div>
          <h3><PiggyBank size={18} /> Earn</h3>
          <p>Deposit USDC or EURC into ArcLend vaults and receive alvUSDC / alvEURC shares that appreciate with yield.</p>
        </div>
        {positions.length > 0 && (
          <div className="earn-totals">
            <span className="muted-small">Earning</span>
            <strong>{totalValue.toFixed(4)}</strong>
            <span className={totalEarnings >= 0 ? 'earn-profit' : 'earn-loss'}>
              {totalEarnings >= 0 ? '+' : ''}{totalEarnings.toFixed(6)}
            </span>
          </div>
        )}
      </div>

      {loading && vaults.length === 0 ? (
        <div className="load-wrap"><div className="loader" /> Loading vaults...</div>
      ) : vaults.length === 0 ? (
        <div className="empty">Earn vaults are unavailable right now. Try again later.</div>
      ) : (
        <div className="earn-grid">
          {vaults.map(vault => {
            const token = vault.token as EarnToken
            const position = positionByToken.get(vault.token)
            const shares = Number(position?.shares) || 0
            const depositsBlocked = vault.maxDeposit != null && vault.maxDeposit <= 0
            return (
              <div className="earn-card" key={vault.id}>
                <div className="earn-card-top">
                  <div>
                    <strong>{vault.id}</strong>
                    <span className="muted-small"> · {vault.provider}</span>
                  </div>
                  <span className="earn-apy">{formatApy(vault)}</span>
                </div>
                <div className="earn-stats">
                  <div><span>TVL</span><strong>{vault.totalAssets.toFixed(2)} {vault.token}</strong></div>
                  <div><span>Share price</span><strong>{vault.sharePrice.toFixed(6)}</strong></div>
                  <div>
                    <span>Your position</span>
                    <strong>
                      {shares > 0
                        ? `${shares.toFixed(6)} ${vault.id} (≈ ${(Number(position?.currentValue) || 0).toFixed(4)} ${vault.token})`
                        : '—'}
                    </strong>
                  </div>
                </div>
                <div className="earn-card-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => onDeposit(token)}
                    disabled={depositsBlocked}
                    title={depositsBlocked ? 'Vault is not accepting deposits right now' : `Deposit ${vault.token}`}
                  >
                    <ArrowDownToLine size={14} /> Deposit
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onWithdraw(token)}
                    disabled={shares <= 0}
                    title={shares <= 0 ? 'No position to withdraw' : `Withdraw ${vault.token}`}
                  >
                    <ArrowUpFromLine size={14} /> Withdraw
                  </button>
                </div>
                {depositsBlocked && (
                  <div className="muted-small">Deposits paused by vault (max deposit 0).</div>
                )}
                <div className="muted-small earn-experimental">
                  <FlaskConical size={12} /> Experimental testnet vault · unaudited
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
