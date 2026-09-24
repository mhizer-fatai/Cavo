import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useCavoAuth } from '../context/AuthContext'
import { loginWithGoogle } from '../lib/google'
import { circleUserIdFromUserKey } from '../lib/identity'
import { createCavoSession, getDeveloperControlledWallet, requestCavoEmailCode, verifyCavoEmailCode } from '../lib/api'
import { Copy, LogOut, Mail } from 'lucide-react'

interface Props {
  /** Extra classes / style to pass to the outermost element */
  className?: string
  username?: string
}

export default function WalletButton({ className = '', username }: Props) {
  const { user, setUser, logout } = useCavoAuth()
  const navigate = useNavigate()
  const [showModal, setShowModal] = useState(false)
  const [loginStep, setLoginStep] = useState<'methods' | 'email'>('methods')
  const [googleLoading, setGoogleLoading] = useState(false)
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailLogin, setEmailLogin] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailCodeSentTo, setEmailCodeSentTo] = useState('')
  const [emailCooldown, setEmailCooldown] = useState(0)
  const [loginError, setLoginError] = useState<string | null>(null)

  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const [copyStatus, setCopyStatus] = useState(false)
  const [usernameCopyStatus, setUsernameCopyStatus] = useState(false)

  const resetLoginModal = () => {
    setShowModal(false)
    setLoginStep('methods')
    setEmailLogin('')
    setEmailCode('')
    setEmailCodeSentTo('')
    setEmailCooldown(0)
    setLoginError(null)
    setGoogleLoading(false)
    setEmailLoading(false)
  }

  const finishLogin = () => {
    resetLoginModal()
    navigate('/dashboard', { replace: true })
  }

  const handleSendEmailCode = async () => {
    const normalizedEmail = emailLogin.trim().toLowerCase()
    if (!normalizedEmail) return
    setEmailLoading(true)
    setLoginError(null)
    try {
      const result = await requestCavoEmailCode(normalizedEmail)
      setEmailCode('')
      setEmailCodeSentTo(result.email)
      setEmailCooldown(result.cooldownSeconds || 60)
    } catch (err: any) {
      setLoginError(err.message || 'Failed to send email code')
    } finally {
      setEmailLoading(false)
    }
  }

  const handleVerifyEmailCode = async () => {
    const normalizedEmail = (emailCodeSentTo || emailLogin).trim().toLowerCase()
    if (!normalizedEmail || emailCode.length !== 6) return
    setEmailLoading(true)
    setLoginError(null)
    try {
      const result = await verifyCavoEmailCode({ email: normalizedEmail, code: emailCode })
      setUser({
        authProvider: 'email',
        providerUserId: result.providerUserId,
        userKey: result.userKey,
        email: result.email,
        circleUserId: circleUserIdFromUserKey(result.userKey),
        cavoSessionToken: result.session.token,
        cavoSessionExpiresAt: result.session.expiresAt,
      })
      finishLogin()
    } catch (err: any) {
      setLoginError(err.message || 'Failed to verify email code')
    } finally {
      setEmailLoading(false)
    }
  }

  const walletStorageKey = user ? `cavo.walletAddress:${user.userKey}` : 'cavo.walletAddress'

  const refreshWalletAddress = async () => {
    if (!user) return null
    const stored = localStorage.getItem(walletStorageKey)
    if (stored) {
      setWalletAddress(stored)
      return stored
    }
    const res = await getDeveloperControlledWallet(user.userKey)
    if (res.exists && res.walletAddress) {
      setWalletAddress(res.walletAddress)
      localStorage.setItem(walletStorageKey, res.walletAddress)
      return res.walletAddress
    }
    return null
  }

  // Fetch the Cavo wallet address when user logs in or opens the dropdown
  useEffect(() => {
    if (!user) return
    refreshWalletAddress().catch(console.error)
  }, [user?.userKey, user?.cavoSessionToken])

  useEffect(() => {
    if (!showDropdown || !user || walletAddress) return
    refreshWalletAddress().catch(console.error)
  }, [showDropdown, user?.userKey, user?.cavoSessionToken, walletAddress])

  useEffect(() => {
    const handleWalletAddressUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!user || detail?.userKey !== user.userKey || !detail?.walletAddress) return
      setWalletAddress(detail.walletAddress)
      localStorage.setItem(walletStorageKey, detail.walletAddress)
    }
    window.addEventListener('cavo:wallet-address-updated', handleWalletAddressUpdate as EventListener)
    return () => window.removeEventListener('cavo:wallet-address-updated', handleWalletAddressUpdate as EventListener)
  }, [user?.userKey, walletStorageKey])

  // Reset cached Cavo wallet address on sign out.
  useEffect(() => {
    if (!user) {
      setWalletAddress(null)
    }
  }, [user])

  useEffect(() => {
    if (emailCooldown <= 0) return
    const timer = window.setInterval(() => {
      setEmailCooldown(value => Math.max(0, value - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [emailCooldown])

  // Copy address to clipboard action
  const handleCopy = async () => {
    const addr = walletAddress || await refreshWalletAddress()
    if (!addr) return
    try {
      await navigator.clipboard.writeText(addr)
      setCopyStatus(true)
      setTimeout(() => {
        setCopyStatus(false)
        setShowDropdown(false)
      }, 1500)
    } catch (error) {
      console.error('Copy address failed:', error)
    }
  }

  const handleCopyUsername = async () => {
    if (!username) return
    try {
      await navigator.clipboard.writeText(`@${username}`)
      setUsernameCopyStatus(true)
      setTimeout(() => {
        setUsernameCopyStatus(false)
        setShowDropdown(false)
      }, 1500)
    } catch (error) {
      console.error('Copy username failed:', error)
    }
  }

  if (user) {
    return (
      // Relative positioning container for dropdown menu alignment
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <button
          className={`btn btn-secondary btn-sm ${className}`}
          onClick={() => setShowDropdown(!showDropdown)}
        >
          {user.email || user.displayName || 'Google'}
        </button>
        {showDropdown && (
          <>
            {/* Invisible full-screen backdrop to handle click-away closing */}
            <div 
              style={{ position: 'fixed', inset: 0, zIndex: 998 }} 
              onClick={() => setShowDropdown(false)} 
            />
            <div className="nav-dropdown" style={{ zIndex: 999 }}>
              {username && (
                <button className="nav-dropdown-item" onClick={handleCopyUsername}>
                  <Copy size={14} />
                  <span>{usernameCopyStatus ? 'Copied!' : 'Copy Username'}</span>
                </button>
              )}
              <button className="nav-dropdown-item" onClick={handleCopy} disabled={!walletAddress}>
                <Copy size={14} />
                <span>{copyStatus ? 'Copied!' : 'Copy Address'}</span>
              </button>
              <button 
                className="nav-dropdown-item" 
                onClick={() => {
                  setShowDropdown(false)
                  logout()
                }}
              >
                <LogOut size={14} />
                <span>Logout</span>
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <button
        id="cavo-login-btn"
        className={`btn btn-primary btn-sm ${className}`}
        onClick={() => {
          setLoginStep('methods')
          setLoginError(null)
          setShowModal(true)
        }}
        disabled={googleLoading || emailLoading}
      >
        {googleLoading || emailLoading ? 'Logging in...' : 'Login'}
      </button>

      {showModal && createPortal(
        <div className="wc-modal" onClick={resetLoginModal}>
          <div className="card wc-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="wc-title">Login</h3>
            <p className="wc-sub">
              {loginStep === 'email'
                ? emailCodeSentTo
                  ? `Enter the 6-digit code sent to ${emailCodeSentTo}.`
                  : 'Enter your email and Cavo will send a 6-digit login code.'
                : 'Use Google or a Cavo email code to access your dashboard.'}
            </p>

            {loginStep === 'methods' && (
              <button
                className="connector-btn"
                disabled={googleLoading}
                onClick={async () => {
                setGoogleLoading(true)
                setLoginError(null)
                const loginWatchdog = window.setTimeout(() => {
                  setLoginError('Google did not finish opening. Please try again.')
                  setGoogleLoading(false)
                }, 45000)
                try {
                  window.addEventListener('cavo:google-login-complete', ((event: Event) => {
                    window.clearTimeout(loginWatchdog)
                    const detail = (event as CustomEvent).detail
                    if (detail?.error) {
                      console.error('Google login failed:', detail.error)
                      setLoginError(detail.errorMessage || detail.error?.message || detail.error?.code || JSON.stringify(detail.error) || 'Google login failed')
                      setGoogleLoading(false)
                      return
                    }
                    const result = detail?.result
                    const providerUserId = result?.oAuthInfo?.socialUserUUID || result?.oAuthInfo?.socialUserInfo?.email
                    if (!providerUserId) {
                      setLoginError('Google login did not return a user id')
                      setGoogleLoading(false)
                      return
                    }
                    const email = result?.oAuthInfo?.socialUserInfo?.email
                    if (!email) {
                      setLoginError('Google login did not return an email address')
                      setGoogleLoading(false)
                      return
                    }
                    createCavoSession({
                      userToken: result.userToken,
                      displayName: result?.oAuthInfo?.socialUserInfo?.name,
                    }).then((session) => {
                      setUser({
                        authProvider: 'google',
                        providerUserId,
                        userKey: session.userKey,
                        email: session.userKey.replace(/^email:/, '') || email,
                        displayName: result?.oAuthInfo?.socialUserInfo?.name,
                        circleUserId: circleUserIdFromUserKey(session.userKey),
                        userToken: result.userToken,
                        encryptionKey: result.encryptionKey,
                        refreshToken: result.refreshToken,
                        cavoSessionToken: session.token,
                        cavoSessionExpiresAt: session.expiresAt,
                      })
                      finishLogin()
                    }).catch((error) => {
                      setLoginError(error.message || 'Failed to create Cavo session')
                      setGoogleLoading(false)
                    })
                  }) as EventListener, { once: true })
                  await loginWithGoogle()
                } catch (err: any) {
                  window.clearTimeout(loginWatchdog)
                  setLoginError(err.message || 'Google login failed')
                  setGoogleLoading(false)
                }
                }}
              >
                <div className="connector-icon">
                  <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style={{ width: 24, height: 24 }} />
                </div>
                <div style={{ textAlign: 'left' }}>
                  <div className="connector-name">{googleLoading ? 'Opening Google...' : 'Continue with Google'}</div>
                  <div className="connector-desc">Gmail login for Cavo</div>
                </div>
              </button>
            )}

            {loginStep === 'methods' ? (
              <button
                className="connector-btn"
                onClick={() => {
                  setLoginStep('email')
                  setLoginError(null)
                }}
              >
                <div className="connector-icon">
                  <Mail size={24} />
                </div>
                <div style={{ textAlign: 'left', flex: 1 }}>
                  <div className="connector-name">Continue with Email</div>
                  <div className="connector-desc">Get a 6-digit Cavo code</div>
                </div>
              </button>
            ) : (
              <div className="form-stack" style={{ marginBottom: 12 }}>
                {!emailCodeSentTo ? (
                  <>
                    <div className="form-group">
                      <label className="form-label">Email</label>
                      <input
                        className="form-input"
                        type="email"
                        placeholder="you@example.com"
                        value={emailLogin}
                        onChange={(event) => setEmailLogin(event.target.value)}
                        disabled={emailLoading}
                      />
                    </div>
                    <button
                      className="btn btn-primary btn-full"
                      disabled={emailLoading || !emailLogin.trim()}
                      onClick={handleSendEmailCode}
                    >
                      {emailLoading ? 'Sending code...' : 'Send Login Code'}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="form-group">
                      <label className="form-label">Verification code</label>
                      <input
                        className="email-code-input"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="000000"
                        maxLength={6}
                        value={emailCode}
                        onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                        disabled={emailLoading}
                      />
                      <p className="muted-small">Check spam if you do not see the email.</p>
                    </div>
                    <button
                      className="btn btn-primary btn-full"
                      disabled={emailLoading || emailCode.length !== 6}
                      onClick={handleVerifyEmailCode}
                    >
                      {emailLoading ? 'Verifying...' : 'Verify and Login'}
                    </button>
                    <button
                      className="btn btn-secondary btn-full"
                      disabled={emailLoading || emailCooldown > 0}
                      onClick={handleSendEmailCode}
                    >
                      {emailCooldown > 0 ? `Resend in ${emailCooldown}s` : 'Resend Code'}
                    </button>
                  </>
                )}
                <button
                  className="btn btn-ghost btn-sm btn-full"
                  disabled={emailLoading}
                  onClick={() => {
                    setLoginStep('methods')
                    setLoginError(null)
                    setEmailCodeSentTo('')
                    setEmailCode('')
                  }}
                >
                  Back
                </button>
              </div>
            )}

            {loginError && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{loginError}</div>}

            <button
              className="btn btn-ghost btn-sm btn-full"
              style={{ marginTop: 14 }}
              onClick={resetLoginModal}
            >
              Cancel
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
