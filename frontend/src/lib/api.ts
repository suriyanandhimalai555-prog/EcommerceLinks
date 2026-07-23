import axios from 'axios'
import { tokenStore } from './auth'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3000',
})

api.interceptors.request.use((config) => {
  const token = tokenStore.getAccess()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

let isRefreshing = false
let failQueue: Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }> = []

function processQueue(err: unknown, token: string | null) {
  failQueue.forEach(({ resolve, reject }) => {
    if (token) resolve(token)
    else reject(err)
  })
  failQueue = []
}

// Auth endpoints return 401 legitimately (wrong password, expired token check).
// Never run the refresh-token interceptor on these — it causes a redirect loop.
const AUTH_ROUTES = ['/auth/login', '/auth/login/verify-otp', '/auth/refresh', '/auth/logout', '/auth/register']

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config
    const isAuthRoute = AUTH_ROUTES.some(r => original?.url?.endsWith(r))
    if (error.response?.status === 401 && !original._retry && !isAuthRoute) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failQueue.push({ resolve, reject })
        }).then((token) => {
          original.headers.Authorization = `Bearer ${token}`
          return api(original)
        })
      }
      original._retry = true
      isRefreshing = true
      const refreshToken = tokenStore.getRefresh()
      if (!refreshToken) {
        tokenStore.clear()
        window.location.href = '/login?reason=session_expired'
        return Promise.reject(error)
      }
      try {
        const { data } = await axios.post(`${import.meta.env.VITE_API_URL || 'http://localhost:3000'}/auth/refresh`, {
          refreshToken,
        })
        tokenStore.setAccess(data.accessToken)
        tokenStore.setRefresh(data.refreshToken) // persist the rotated refresh token
        processQueue(null, data.accessToken)
        original.headers.Authorization = `Bearer ${data.accessToken}`
        return api(original)
      } catch (err) {
        processQueue(err, null)
        tokenStore.clear()
        window.location.href = '/login?reason=session_expired'
        return Promise.reject(err)
      } finally {
        isRefreshing = false
      }
    }
    return Promise.reject(error)
  }
)

export default api
