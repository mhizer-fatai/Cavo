type BalanceCardProps = {
  walletAddress?: string
  usdcDisplay: string
  eurcDisplay: string
  syncing?: boolean
  shortenAddress: (address: string) => string
}

export default function BalanceCard({
  walletAddress,
  usdcDisplay,
  eurcDisplay,
  syncing,
  shortenAddress,
}: BalanceCardProps) {
  const hasWallet = Boolean(walletAddress)

  return (
    <div className="virtual-card">
      <div className="card-header">
        <div className="card-brand">
          <img src="/cavo-logo.png" alt="Cavo" className="card-brand-logo" />
          <img src="/cavo-wordmark.png" alt="Cavo" className="card-brand-wordmark" />
        </div>
        <div className="card-header-right">
          {syncing && (
            <div className="balance-sync" aria-label="Refreshing balances">
              <span />
              Syncing
            </div>
          )}
          <div className="card-chip" />
        </div>
      </div>
      <div className="card-middle">
        <div className="card-label">Available balances</div>
        <div className="card-balance-grid">
          <div className="card-balance-col">
            <div className="card-asset-label">
              <img src="/usdc-logo.png" alt="" className="token-logo" />
              <span>USDC</span>
            </div>
            <div className="card-balance">
              {hasWallet ? usdcDisplay : '0.00'}
            </div>
          </div>
          <div className="card-balance-col">
            <div className="card-asset-label">
              <img src="/eurc-logo.png" alt="" className="token-logo" />
              <span>EURC</span>
            </div>
            <div className="card-balance">
              {hasWallet ? eurcDisplay : '0.00'}
            </div>
          </div>
        </div>
      </div>
      <div className="card-footer">
        <div className="card-number">
          {hasWallet && walletAddress ? shortenAddress(walletAddress) : '.... .... .... ....'}
        </div>
        <div className="card-network">Arc Network</div>
      </div>
    </div>
  )
}
