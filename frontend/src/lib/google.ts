const GOOGLE_STATE_KEY = 'cavopay.googleOAuthState'
const GOOGLE_NONCE_KEY = 'cavopay.googleOAuthNonce'
const GOOGLE_GSI_SCRIPT = 'https://accounts.google.com/gsi/client'

declare global {
  interface Window {
    google?: any
  }
}

function getGoogleClientId() {
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  if (!googleClientId) throw new Error('VITE_GOOGLE_CLIENT_ID is not configured')
  return googleClientId
}

function randomToken() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function decodeJwtPayload(token: string) {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('Google login did not return a valid token')
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return JSON.parse(atob(padded))
}

function buildGoogleResultFromProfile(profile: {
  sub?: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}, userToken: string) {
  const email = String(profile.email || '').toLowerCase()
  if (!email) throw new Error('Google login did not return an email address')
  if (profile.email_verified === false) throw new Error('Google email is not verified')

  return {
    userToken,
    encryptionKey: undefined,
    refreshToken: undefined,
    oAuthInfo: {
      socialUserUUID: String(profile.sub || email),
      socialUserInfo: {
        email,
        name: profile.name,
        picture: profile.picture,
      },
    },
  }
}

function buildGoogleResult(idToken: string, expectedNonce?: string | null) {
  const payload = decodeJwtPayload(idToken)
  if (payload.aud !== getGoogleClientId()) throw new Error('Google login token was issued for a different app')
  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error('Google login nonce did not match. Please try again.')
  }
  return buildGoogleResultFromProfile(payload, idToken)
}

async function buildGoogleResultFromAccessToken(accessToken: string) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error('Google login could not fetch account profile')
  const profile = await response.json()
  return buildGoogleResultFromProfile({
    sub: profile.sub,
    email: profile.email,
    email_verified: profile.email_verified,
    name: profile.name,
    picture: profile.picture,
  }, accessToken)
  }

function dispatchGoogleComplete(error: any, result: any = null) {
  window.dispatchEvent(new CustomEvent('cavopay:google-login-complete', {
    detail: { error, errorMessage: error?.message || String(error || ''), result },
  }))
}

function loadGoogleIdentityScript() {
  return new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve()
      return
    }

    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_GSI_SCRIPT}"]`)
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true })
      existingScript.addEventListener('error', () => reject(new Error('Could not load Google login script')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = GOOGLE_GSI_SCRIPT
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load Google login script'))
    document.head.appendChild(script)
  })
}

export async function loginWithGoogle() {
  try {
    await loadGoogleIdentityScript()
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: getGoogleClientId(),
      scope: 'openid email profile',
      prompt: 'select_account',
      callback: async (response: any) => {
        try {
          if (response?.error) throw new Error(response.error_description || response.error)
          if (!response?.access_token) throw new Error('Google login did not return an access token')
          const result = await buildGoogleResultFromAccessToken(response.access_token)
          dispatchGoogleComplete(null, result)
        } catch (error) {
          dispatchGoogleComplete(error)
        }
      },
    })
    tokenClient.requestAccessToken()
    return
  } catch (error) {
    dispatchGoogleComplete(error)
    throw error
  }
}

export async function loginWithGoogleRedirect() {
  const state = randomToken()
  const nonce = randomToken()
  sessionStorage.setItem(GOOGLE_STATE_KEY, state)
  sessionStorage.setItem(GOOGLE_NONCE_KEY, nonce)

  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    redirect_uri: `${window.location.origin}/auth/callback`,
    response_type: 'token id_token',
    scope: 'openid email profile',
    nonce,
    state,
    prompt: 'select_account',
  })

  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
}

export async function completeGoogleLoginFromRedirect() {
  const isCallbackRoute = window.location.pathname === '/auth/callback'
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const query = new URLSearchParams(window.location.search)
  const idToken = hash.get('id_token') || query.get('id_token')
  const accessToken = hash.get('access_token') || query.get('access_token')
  const error = hash.get('error') || query.get('error')

  if (!isCallbackRoute && !idToken && !accessToken && !error) return null
  if (error) throw new Error(query.get('error_description') || hash.get('error_description') || error)

  const expectedState = sessionStorage.getItem(GOOGLE_STATE_KEY)
  const returnedState = hash.get('state') || query.get('state')
  const expectedNonce = sessionStorage.getItem(GOOGLE_NONCE_KEY)
  sessionStorage.removeItem(GOOGLE_STATE_KEY)
  sessionStorage.removeItem(GOOGLE_NONCE_KEY)

  // Strict state binding (L4): we always generate a state for the redirect
  // flow, so a missing or mismatched value means tampering or expiry.
  if (!expectedState) {
    throw new Error('Google login session expired. Please try again.')
  }
  if (returnedState !== expectedState) {
    throw new Error('Google login state did not match. Please try again.')
  }

  window.history.replaceState({}, document.title, '/auth/callback')
  if (idToken) return buildGoogleResult(idToken, expectedNonce)
  if (accessToken) return buildGoogleResultFromAccessToken(accessToken)
  throw new Error('Google login did not return account details')
}
