import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { completeGoogleLoginFromRedirect } from '../lib/google'
import { createCavoSession, logoutCavoSession, refreshCavoSession, setMemorySessionToken } from '../lib/api'
import { buildGoogleUserKey, circleUserIdFromUserKey } from '../lib/identity'

export type CavoAuthUser = {
  authProvider: 'google' | 'email'
  providerUserId: string
  userKey: string
  email?: string
  displayName?: string
  circleUserId?: string
  userToken?: string
  encryptionKey?: string
  refreshToken?: string
  cavoSessionToken?: string
  cavoSessionExpiresAt?: string
}

type AuthContextValue = {
  user: CavoAuthUser | null
  isAuthLoading: boolean
  setUser: (user: CavoAuthUser) => void
  logout: () => void
}

const STORAGE_KEY = 'cavo.authUser'
const AuthContext = createContext<AuthContextValue | null>(null)

// Persist the profile WITHOUT the access token (M3: tokens live in memory
// only). The token is mirrored into the api module's memory store.
function persistUser(user: CavoAuthUser) {
  const { cavoSessionToken: _dropped, ...rest } = user
  setMemorySessionToken(user.cavoSessionToken ?? null)
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

async function withCavoSession(user: CavoAuthUser): Promise<CavoAuthUser> {
  // The Google credential (ID token or access token) is verified server-side
  // via Google tokeninfo. The backend-derived userKey is authoritative —
  // client-declared identity is never trusted.
  const session = await createCavoSession({
    userToken: user.userToken,
    displayName: user.displayName,
  })
  const verifiedEmail = session.userKey.replace(/^email:/, '')
  return {
    ...user,
    userKey: session.userKey,
    email: verifiedEmail || user.email,
    cavoSessionToken: session.token,
    cavoSessionExpiresAt: session.expiresAt,
  }
}

async function refreshStoredSession(user: CavoAuthUser): Promise<CavoAuthUser> {
  // Silent re-login via the HttpOnly refresh cookie — no identity proof needed
  // because the cookie itself is the proof.
  const session = await refreshCavoSession()
  return {
    ...user,
    cavoSessionToken: session.token,
    cavoSessionExpiresAt: session.expiresAt,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<CavoAuthUser | null>(() => {
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
        const nextUser = await withCavoSession({
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
      if (!nextUser.cavoSessionToken) {
        refreshStoredSession(nextUser)
          .then((sessionUser) => {
            setUserState(sessionUser)
            persistUser(sessionUser)
          })
          .catch((error) => {
            console.error('Cavo session refresh failed:', error)
            setUserState(null)
            clearPersistedUser()
          })
      }
    },
    logout: () => {
      logoutCavoSession()
      setUserState(null)
      clearPersistedUser()
      localStorage.removeItem('cavo.walletAddress')
      if (user?.userKey) localStorage.removeItem(`cavo.walletAddress:${user.userKey}`)
    },
  }), [isAuthLoading, user])

  useEffect(() => {
    if (!user || user.cavoSessionToken) return
    let cancelled = false
    refreshStoredSession(user)
      .then((sessionUser) => {
        if (cancelled) return
        setUserState(sessionUser)
        persistUser(sessionUser)
      })
      .catch((error) => {
        if (cancelled) return
        console.error('Cavo session refresh failed:', error)
        setUserState(null)
        clearPersistedUser()
      })
    return () => { cancelled = true }
  }, [user])

  useEffect(() => {
    const handleSessionExpired = () => {
      setUserState(null)
      clearPersistedUser()
      localStorage.removeItem('cavo.walletAddress')
      if (user?.userKey) localStorage.removeItem(`cavo.walletAddress:${user.userKey}`)
      navigate('/dashboard', { replace: true })
    }

    window.addEventListener('cavo:session-expired', handleSessionExpired)
    return () => window.removeEventListener('cavo:session-expired', handleSessionExpired)
  }, [navigate, user?.userKey])

  if (isAuthLoading) {
    return (
      <AuthContext.Provider value={value}>
        <div className="auth-callback-screen">
          <div className="loader" />
          <div className="auth-callback-title">Finishing sign in</div>
          <div className="auth-callback-sub">Securing your Cavo session...</div>
        </div>
      </AuthContext.Provider>
    )
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useCavoAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useCavoAuth must be used within AuthProvider')
  return ctx
}
