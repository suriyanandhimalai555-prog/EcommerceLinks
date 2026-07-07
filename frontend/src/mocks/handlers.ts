import { http, HttpResponse, delay } from 'msw'
import {
  mockMe, mockDashboard, mockTree, mockNetworkSummary, mockDirects,
  mockProducts, mockWallet, mockLedger, mockPayouts, mockPairs,
  mockWithdrawals, mockRanks,
} from './data'

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export const handlers = [
  // auth
  http.post(`${BASE}/auth/login`, async () => {
    await delay(300)
    return HttpResponse.json({
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      member: mockMe,
    })
  }),
  http.post(`${BASE}/auth/register`, async () => {
    await delay(400)
    return HttpResponse.json({ memberCode: 'AGV999999' }, { status: 201 })
  }),
  http.post(`${BASE}/auth/refresh`, async () => {
    await delay(100)
    return HttpResponse.json({ accessToken: 'mock-access-token-refreshed' })
  }),
  http.get(`${BASE}/me`, async () => {
    await delay(150)
    return HttpResponse.json(mockMe)
  }),
  http.put(`${BASE}/me`, async () => {
    await delay(200)
    return HttpResponse.json(mockMe)
  }),
  http.put(`${BASE}/me/kyc`, async () => {
    await delay(300)
    return HttpResponse.json({ ...mockMe, kycStatus: 'pending' })
  }),
  http.put(`${BASE}/me/bank`, async () => {
    await delay(300)
    return HttpResponse.json({ ...mockMe, bankStatus: 'pending' })
  }),

  // dashboard
  http.get(`${BASE}/dashboard`, async () => {
    await delay(200)
    return HttpResponse.json(mockDashboard)
  }),

  // products & orders
  http.get(`${BASE}/products`, async () => {
    await delay(150)
    return HttpResponse.json(mockProducts)
  }),
  http.post(`${BASE}/orders`, async () => {
    await delay(400)
    return HttpResponse.json({ orderId: 'ORD-MOCK-001', totalPaise: 2950000, status: 'created' }, { status: 201 })
  }),
  http.get(`${BASE}/orders/:orderId`, async () => {
    await delay(200)
    return HttpResponse.json({ orderId: 'ORD-MOCK-001', status: 'confirmed', productName: 'Business Pack', totalPaise: 2950000 })
  }),
  http.post(`${BASE}/dev/simulate-payment`, async () => {
    await delay(600)
    return HttpResponse.json({ success: true })
  }),

  // network
  http.get(`${BASE}/network/tree`, async ({ request }) => {
    await delay(200)
    const url = new URL(request.url)
    const root = url.searchParams.get('root') || 'me'
    if (root === 'me' || root === 'AGV123456') return HttpResponse.json(mockTree)
    const findNode = (node: typeof mockTree | null, code: string): typeof mockTree | null => {
      if (!node) return null
      if (node.memberCode === code) return node
      return findNode(node.left, code) || findNode(node.right, code)
    }
    const found = findNode(mockTree, root)
    return HttpResponse.json(found || mockTree)
  }),
  http.get(`${BASE}/network/summary`, async () => {
    await delay(150)
    return HttpResponse.json(mockNetworkSummary)
  }),
  http.get(`${BASE}/network/directs`, async () => {
    await delay(150)
    return HttpResponse.json({ items: mockDirects, nextCursor: null })
  }),

  // income
  http.get(`${BASE}/pairs`, async () => {
    await delay(200)
    return HttpResponse.json({ items: mockPairs.slice(0, 10), nextCursor: 'cursor-page-2' })
  }),
  http.get(`${BASE}/wallet`, async () => {
    await delay(150)
    return HttpResponse.json(mockWallet)
  }),
  http.get(`${BASE}/wallet/ledger`, async ({ request }) => {
    await delay(200)
    const url = new URL(request.url)
    const cursor = url.searchParams.get('cursor')
    if (cursor) return HttpResponse.json({ items: mockLedger.slice(5), nextCursor: null })
    return HttpResponse.json({ items: mockLedger.slice(0, 5), nextCursor: 'cursor-2' })
  }),
  http.get(`${BASE}/payouts`, async () => {
    await delay(150)
    return HttpResponse.json({ items: mockPayouts })
  }),
  http.post(`${BASE}/withdrawals`, async ({ request }) => {
    await delay(300)
    const body = await request.json() as { amountPaise: number }
    if (body.amountPaise < 50000) {
      return HttpResponse.json({ error: { code: 'MIN_AMOUNT', message: 'Minimum withdrawal is ₹500' } }, { status: 422 })
    }
    if (body.amountPaise > mockWallet.balancePaise) {
      return HttpResponse.json({ error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' } }, { status: 422 })
    }
    return HttpResponse.json({ id: 'WD-MOCK-NEW' }, { status: 201 })
  }),
  http.get(`${BASE}/withdrawals`, async () => {
    await delay(150)
    return HttpResponse.json({ items: mockWithdrawals })
  }),

  // ranks
  http.get(`${BASE}/ranks/progress`, async () => {
    await delay(200)
    return HttpResponse.json({ levels: mockRanks })
  }),
]
