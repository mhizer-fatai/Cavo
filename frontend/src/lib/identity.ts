const DEV_IDENTITY_KEY = 'cavopay.circleIdentityVersion'

export function getDevIdentityVersion() {
  if (!import.meta.env.DEV) return 1
  const raw = Number(window.localStorage.getItem(DEV_IDENTITY_KEY) || '1')
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1
}

export function nextDevIdentityVersion() {
  const next = getDevIdentityVersion() + 1
  window.localStorage.setItem(DEV_IDENTITY_KEY, String(next))
  return next
}

export function buildEmailUserKey(email: string) {
  const base = `email:${email.trim().toLowerCase()}`
  const version = getDevIdentityVersion()
  return import.meta.env.DEV && version > 1 ? `${base}:dev${version}` : base
}

export function buildGoogleUserKey(email: string) {
  return buildEmailUserKey(email)
}

export function circleUserIdFromUserKey(userKey: string) {
  const normalized = userKey.toLowerCase().replace(/[^a-z0-9]/g, '_')
  const candidate = `cavopay_${normalized}`
  if (candidate.length <= 49) return candidate

  let hash = 0
  for (let i = 0; i < normalized.length; i += 1) {
    hash = Math.imul(31, hash) + normalized.charCodeAt(i) | 0
  }
  return `cavopay_${Math.abs(hash).toString(36)}_${normalized.slice(-24)}`.slice(0, 49)
}
