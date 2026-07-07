import { Navigate, useLocation } from 'react-router-dom'
import { tokenStore } from '../lib/auth'

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const hasRefresh = !!tokenStore.getRefresh()
  const hasAccess = !!tokenStore.getAccess()

  if (!hasRefresh && !hasAccess) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}
