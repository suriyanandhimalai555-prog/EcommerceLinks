import { useState, useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { tokenStore, bootstrapAuth } from '../lib/auth'

/**
 * RequireAuth — gates all protected routes.
 *
 * On every mount (including hard-refresh):
 *   1. If no refresh token at all → redirect to /login immediately (no flash).
 *   2. If an in-memory access token already exists → render children immediately
 *      (user just logged in, no round-trip needed).
 *   3. Otherwise (access token wiped by refresh, but refresh token in localStorage)
 *      → call bootstrapAuth() to exchange the refresh token for a fresh access token,
 *        show a loading splash while the single request resolves, then render children.
 *        On failure → redirect to /login.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation()

  // Short-circuit: if there's no refresh token at all, skip the async path
  // entirely — user is definitively logged out.
  const hasRefreshToken = !!tokenStore.getRefresh()
  if (!hasRefreshToken) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <AuthBootstrap location={location}>{children}</AuthBootstrap>
}

function AuthBootstrap({
  children,
  location,
}: {
  children: React.ReactNode
  location: ReturnType<typeof useLocation>
}) {
  // 'pending' while the bootstrap request is in flight;
  // 'ok' once we have an access token; 'fail' if the refresh was rejected.
  const [status, setStatus] = useState<'pending' | 'ok' | 'fail'>(() =>
    tokenStore.getAccess() ? 'ok' : 'pending'
  )

  useEffect(() => {
    if (status !== 'pending') return
    let cancelled = false
    bootstrapAuth().then((ok) => {
      if (!cancelled) setStatus(ok ? 'ok' : 'fail')
    })
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'fail') {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (status === 'pending') {
    return (
      <div className="min-h-screen bg-surface-page flex flex-col items-center justify-center gap-4">
        <img src="/AVG_logo_nobackground.png" alt="AVG" className="w-14 h-14 animate-pulse" />
        <p className="text-sm text-ink-muted">Loading your session…</p>
      </div>
    )
  }

  return <>{children}</>
}
