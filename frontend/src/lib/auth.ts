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
