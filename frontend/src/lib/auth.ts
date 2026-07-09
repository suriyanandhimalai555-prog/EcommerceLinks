import axios from 'axios'
import type { Me } from '../types/api'

let _accessToken: string | null = null
let _me: Me | null = null

export const tokenStore = {
  getAccess: () => _accessToken,
  setAccess: (t: string | null) => { _accessToken = t },
  getRefresh: () => localStorage.getItem('avg_refresh'),
  setRefresh: (t: string | null) => {
    if (t) localStorage.setItem('avg_refresh', t)
    else localStorage.removeItem('avg_refresh')
  },
  setMe: (me: Me | null) => { _me = me },
  getMe: () => _me,
  clear: () => {
    _accessToken = null
    _me = null
    localStorage.removeItem('avg_refresh')
  },
}

/**
 * G-9: revoke the current refresh token on the server before clearing local state.
 * Best-effort — always clears local state even if the server call fails.
 */
export async function logout(): Promise<void> {
  const refreshToken = tokenStore.getRefresh()
  if (refreshToken) {
    const base = import.meta.env.VITE_API_URL || 'http://localhost:3000'
    await axios.post(`${base}/auth/logout`, { refreshToken }).catch(() => null)
  }
  tokenStore.clear()
}

/**
 * Called once on app boot (inside RequireAuth). If an access token is already
 * in memory (e.g. just logged in, no refresh needed) returns true immediately.
 * If a refresh token exists in localStorage, exchanges it for a fresh access
 * token + rotated refresh token and stores both. Returns false if no session
 * exists or the exchange fails (caller should redirect to /login).
 *
 * Module-level in-flight dedup: React StrictMode double-invokes effects, so
 * two concurrent bootstrapAuth() calls can race. Without dedup both would POST
 * /auth/refresh with the same token — the backend rotates on the first and
 * the second gets 401 "Token revoked", triggering tokenStore.clear() → logout.
 * Sharing one in-flight Promise collapses the two calls into a single request.
 * The promise is cleared in .finally() so a genuine failure still allows retry.
 */
let _bootstrapPromise: Promise<boolean> | null = null

export function bootstrapAuth(): Promise<boolean> {
  // Already have a valid in-memory access token — nothing to do.
  if (tokenStore.getAccess()) return Promise.resolve(true)
  // Reuse the in-flight request if one is already running.
  if (_bootstrapPromise) return _bootstrapPromise
  _bootstrapPromise = doBootstrap().finally(() => { _bootstrapPromise = null })
  return _bootstrapPromise
}

async function doBootstrap(): Promise<boolean> {
  const refreshToken = tokenStore.getRefresh()
  if (!refreshToken) return false

  try {
    const base = import.meta.env.VITE_API_URL || 'http://localhost:3000'
    // Use raw axios (no interceptor) to avoid circular refresh loops.
    const { data } = await axios.post(`${base}/auth/refresh`, { refreshToken })
    tokenStore.setAccess(data.accessToken)
    tokenStore.setRefresh(data.refreshToken) // persist the rotated token
    return true
  } catch {
    tokenStore.clear()
    return false
  }
}
