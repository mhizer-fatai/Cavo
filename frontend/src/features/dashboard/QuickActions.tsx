import { ArrowLeftRight, ArrowUpFromLine, PiggyBank, QrCode, ScanLine, Send } from 'lucide-react'
import type { Profile } from '../../lib/api'

type QuickActionsProps = {
  profile: Profile | null
  disabled: boolean
  onSend: () => void
  onSwap: () => void
  onEarn: () => void
  onWithdraw: () => void
  onReceive: () => void
  onScanQr: () => void
}

export default function QuickActions({
  profile,
  disabled,
  onSend,
  onSwap,
  onEarn,
  onWithdraw,
  onReceive,
  onScanQr,
}: QuickActionsProps) {
  return (
    <div className="card glass quick-actions-card">
      <div className="quick-actions-heading">
        <h3>Actions</h3>
        <p>Send, swap, earn, receive, or scan a Cavo QR on mobile.</p>
      </div>
      <div className="quick-actions-content">
        <div className="quick-actions-row">
          <button className="quick-action-tile primary" onClick={onSend} disabled={disabled}>
            <Send size={20} />
            <span>Send</span>
          </button>
          <button className="quick-action-tile" onClick={onSwap} disabled={disabled}>
            <ArrowLeftRight size={20} />
            <span>Swap</span>
          </button>
          <button className="quick-action-tile" onClick={onEarn} disabled={disabled}>
            <PiggyBank size={20} />
            <span>Earn</span>
          </button>
          <button className="quick-action-tile" onClick={onWithdraw} disabled={disabled}>
            <ArrowUpFromLine size={20} />
            <span>Withdraw</span>
          </button>
          <button className="quick-action-tile" onClick={onReceive} disabled={disabled}>
            <QrCode size={20} />
            <span>Receive</span>
          </button>
          {profile && (
            <button className="quick-action-tile scan-qr-action" onClick={onScanQr} disabled={disabled}>
              <ScanLine size={20} />
              <span>Scan QR</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
