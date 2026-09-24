import { X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import CopyButton from '../../components/CopyButton'
import type { Profile } from '../../lib/api'

type ReceiveModalProps = {
  claimError: string | null
  claimLoading: boolean
  claimName: string
  loginLabel: string
  cavopayWalletAddress?: string
  profile: Profile | null
  qrValue: string
  onClaim: () => void
  onClaimNameChange: (value: string) => void
  onClose: () => void
}

export default function ReceiveModal({
  claimError,
  claimLoading,
  claimName,
  loginLabel,
  cavopayWalletAddress,
  profile,
  qrValue,
  onClaim,
  onClaimNameChange,
  onClose,
}: ReceiveModalProps) {
  return (
    <div className="wc-modal" onClick={onClose}>
      <div className="card glass wc-card receive-card" onClick={event => event.stopPropagation()}>
        <div className="wc-title modal-title-row">
          Receive Payment
          <button className="icon-btn" onClick={onClose} aria-label="Close receive payment">
            <X size={20} />
          </button>
        </div>
        <div className="wc-sub receive-sub">
          Show this QR to receive a Cavopay payment. The payer opens your profile, reviews the details, and sends funds to your Cavopay wallet on Arc.
        </div>

        <div className="receive-body">
          <div className="receive-qr-panel">
            <div className="receive-qr-box">
              <QRCodeSVG value={qrValue} size={180} />
            </div>
            {profile && <div className="receive-username">@{profile.username}</div>}
          </div>

          <div className="form-stack receive-details">
            {profile && (
              <div className="form-group">
                <label className="form-label">Your Cavopay QR Link</label>
                <div className="link-box receive-link-box">
                  <span className="link-url">{window.location.origin}/u/{profile.username}</span>
                  <CopyButton text={`${window.location.origin}/u/${profile.username}`} />
                </div>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Cavopay Wallet Address</label>
              <div className="link-box receive-link-box">
                <span className="link-url">{cavopayWalletAddress || 'Creating Cavopay wallet...'}</span>
                {cavopayWalletAddress && <CopyButton text={cavopayWalletAddress} />}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Connected Login Wallet</label>
              <div className="link-box receive-link-box muted">
                <span className="link-url">{loginLabel}</span>
              </div>
            </div>
          </div>
        </div>

        {!profile && (
          <div className="receive-claim-box">
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Claim Your Profile</h3>
              <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 12 }}>
                Create a custom link to make getting paid easier.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Username"
                  value={claimName}
                  onChange={event => onClaimNameChange(event.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))}
                />
                <button className="btn btn-primary" onClick={onClaim} disabled={claimLoading || !claimName || !cavopayWalletAddress}>
                  {claimLoading ? '...' : 'Claim'}
                </button>
              </div>
              {claimError && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{claimError}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
