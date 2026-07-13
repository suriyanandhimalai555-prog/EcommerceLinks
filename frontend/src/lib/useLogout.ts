import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { logout } from './auth'

/** Shared logout flow: revoke the refresh token, drop all cached data, go to login. */
export function useLogout() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  return async () => {
    await logout()
    queryClient.clear()
    navigate('/login')
  }
}
