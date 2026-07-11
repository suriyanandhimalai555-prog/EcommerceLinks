import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AppShell from './components/layout/AppShell'
import { RequireAuth } from './routes/guard'
import Login from './pages/auth/Login'

// Route-level code splitting: each page loads on first visit, keeping the
// initial bundle free of heavy deps (recharts ships only with chart pages).
const Register = lazy(() => import('./pages/auth/Register'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Network = lazy(() => import('./pages/Network'))
const BuyProduct = lazy(() => import('./pages/BuyProduct'))
const Profile = lazy(() => import('./pages/Profile'))
const Wallet = lazy(() => import('./pages/Wallet'))
const PayoutHistory = lazy(() => import('./pages/PayoutHistory'))
const PairMatch = lazy(() => import('./pages/PairMatch'))
const IncomeReport = lazy(() => import('./pages/IncomeReport'))
const RankRewards = lazy(() => import('./pages/RankRewards'))
const DirectMembers = lazy(() => import('./pages/DirectMembers'))
const Notifications = lazy(() => import('./pages/Notifications'))
const Support = lazy(() => import('./pages/Support'))
const Settings = lazy(() => import('./pages/Settings'))

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1 },
  },
})

function PageFallback() {
  return (
    <div className="space-y-6">
      <div className="avg-card p-5 space-y-3">
        <div className="h-4 w-1/3 bg-white/10 rounded animate-pulse" />
        <div className="h-3 w-full bg-white/5 rounded animate-pulse" />
        <div className="h-3 w-2/3 bg-white/5 rounded animate-pulse" />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route element={<RequireAuth><AppShell /></RequireAuth>}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/network" element={<Network />} />
              <Route path="/genealogy" element={<Network />} />
              <Route path="/buy" element={<BuyProduct />} />
              <Route path="/pairs" element={<PairMatch />} />
              <Route path="/wallet" element={<Wallet />} />
              <Route path="/payouts" element={<PayoutHistory />} />
              <Route path="/directs" element={<DirectMembers />} />
              <Route path="/income" element={<IncomeReport />} />
              <Route path="/ranks" element={<RankRewards />} />
              <Route path="/support" element={<Support />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
