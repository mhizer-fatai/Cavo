import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { completeGoogleLoginFromRedirect } from '../lib/google'
import { createCavopaySession, logoutCavopaySession, refreshCavopaySession, setMemorySessionToken } from '../lib/api'
import { buildGoogleUserKey, circleUserIdFromUserKey } from '../lib/identity'

export type CavopayAuthUser = {
  authProvider: 'google' | 'email'
  providerUserId: string
  userKey: string
  email?: string
  displayName?: string
  circleUserId?: string
  userToken?: string
  encryptionKey?: string
  refreshToken?: string
  cavopaySessionToken?: string
  cavopaySessionExpiresAt?: string
}

type AuthContextValue = {
  user: CavopayAuthUser | null
  isAuthLoading: boolean
  setUser: (user: CavopayAuthUser) => void
  logout: () => void
}

const STORAGE_KEY = 'cavopay.authUser'
const AuthContext = createContext<AuthContextValue | null>(null)

// Persist the profile WITHOUT the access token (M3: tokens live in memory
// only). The token is mirrored into the api module's memory store.
function persistUser(user: CavopayAuthUser) {
  const { cavopaySessionToken: _dropped, ...rest } = user
  setMemorySessionToken(user.cavopaySessionToken ?? null)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rest))
}

function clearPersistedUser() {
  setMemorySessionToken(null)
  localStorage.removeItem(STORAGE_KEY)
}

function isGoogleCallbackUrl() {
  return window.location.pathname === '/auth/callback'
    || window.location.hash.includes('access_token')
    || window.location.hash.includes('id_token')
}

async function withCavopaySession(user: CavopayAuthUser): Promise<CavopayAuthUser> {
  // The Google credential (ID token or access token) is verified server-side
  // via Google tokeninfo. The backend-derived userKey is authoritative —
  // client-declared identity is never trusted.
  const session = await createCavopaySession({
    userToken: user.userToken,
    displayName: user.displayName,
  })
  const verifiedEmail = session.userKey.replace(/^email:/, '')
  return {
    ...user,
    userKey: session.userKey,
    email: verifiedEmail || user.email,
    cavopaySessionToken: session.token,
    cavopaySessionExpiresAt: session.expiresAt,
  }
}

async function refreshStoredSession(user: CavopayAuthUser): Promise<CavopayAuthUser> {
  // Silent re-login via the HttpOnly refresh cookie — no identity proof needed
  // because the cookie itself is the proof.
  const session = await refreshCavopaySession()
  return {
    ...user,
    cavopaySessionToken: session.token,
    cavopaySessionExpiresAt: session.expiresAt,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<CavopayAuthUser | null>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    try {
      return JSON.parse(stored)
    } catch {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
  })
  const [isAuthLoading, setIsAuthLoading] = useState(() => {
    return isGoogleCallbackUrl()
  })
  const navigate = useNavigate()

  useEffect(() => {
    if (!isGoogleCallbackUrl()) {
      setIsAuthLoading(false)
      return
    }

    let cancelled = false
    setIsAuthLoading(true)

    completeGoogleLoginFromRedirect()
      .then(async (result) => {
        if (cancelled || !result) return
        const providerUserId = result?.oAuthInfo?.socialUserUUID || result?.oAuthInfo?.socialUserInfo?.email
        if (!providerUserId) throw new Error('Google login did not return a user id')
        const email = result?.oAuthInfo?.socialUserInfo?.email
        if (!email) throw new Error('Google login did not return an email address')
        const nextUser = await withCavopaySession({
          authProvider: 'google',
          providerUserId,
          userKey: buildGoogleUserKey(email),
          email,
          displayName: result?.oAuthInfo?.socialUserInfo?.name,
          circleUserId: circleUserIdFromUserKey(buildGoogleUserKey(email)),
          userToken: result.userToken,
          encryptionKey: result.encryptionKey,
          refreshToken: result.refreshToken,
        })
        setUserState(nextUser)
        persistUser(nextUser)
        navigate('/dashboard', { replace: true })
      })
      .catch((error) => {
        console.error('Google login callback failed:', error)
        if (!cancelled) navigate('/', { replace: true })
      })
      .finally(() => {
        if (!cancelled) setIsAuthLoading(false)
      })
    return () => { cancelled = true }
  }, [navigate])

  const value = useMemo<AuthContextValue>(() => ({
    user,
    isAuthLoading,
    setUser: (nextUser) => {
      setUserState(nextUser)
      persistUser(nextUser)
      if (!nextUser.cavopaySessionToken) {
        refreshStoredSession(nextUser)
          .then((sessionUser) => {
            setUserState(sessionUser)
            persistUser(sessionUser)
          })
          .catch((error) => {
            console.error('Cavopay session refresh failed:', error)
            setUserState(null)
            clearPersistedUser()
          })
      }
    },
    logout: () => {
      logoutCavopaySession()
      setUserState(null)
      clearPersistedUser()
      localStorage.removeItem('cavopay.walletAddress')
      if (user?.userKey) localStorage.removeItem(`cavopay.walletAddress:${user.userKey}`)
    },
  }), [isAuthLoading, user])

  useEffect(() => {
    if (!user || user.cavopaySessionToken) return
    let cancelled = false
    refreshStoredSession(user)
      .then((sessionUser) => {
        if (cancelled) return
        setUserState(sessionUser)
        persistUser(sessionUser)
      })
      .catch((error) => {
        if (cancelled) return
        console.error('Cavopay session refresh failed:', error)
        setUserState(null)
        clearPersistedUser()
      })
    return () => { cancelled = true }
  }, [user])

  useEffect(() => {
    const handleSessionExpired = () => {
      setUserState(null)
      clearPersistedUser()
      localStorage.removeItem('cavopay.walletAddress')
      if (user?.userKey) localStorage.removeItem(`cavopay.walletAddress:${user.userKey}`)
      navigate('/dashboard', { replace: true })
    }

    window.addEventListener('cavopay:session-expired', handleSessionExpired)
    return () => window.removeEventListener('cavopay:session-expired', handleSessionExpired)
  }, [navigate, user?.userKey])

  if (isAuthLoading) {
    return (
      <AuthContext.Provider value={value}>
        <div className="auth-callback-screen">
          <div className="loader" />
          <div className="auth-callback-title">Finishing sign in</div>
          <div className="auth-callback-sub">Securing your Cavopay session...</div>
        </div>
      </AuthContext.Provider>
    )
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useCavopayAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useCavopayAuth must be used within AuthProvider')
  return ctx
}
