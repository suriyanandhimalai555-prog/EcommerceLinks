import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AppShell from './components/layout/AppShell'
import { RequireAuth, RequireAdmin, MemberHome } from './routes/guard'
import { SkeletonCard } from './components/ui/Skeleton'
import Login from './pages/auth/Login'

// Route-level code splitting: each page loads on first visit, keeping the
// initial bundle free of heavy deps (recharts ships only with chart pages).
const Register = lazy(() => import('./pages/auth/Register'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Network = lazy(() => import('./pages/Network'))
const BuyProduct = lazy(() => import('./pages/BuyProduct'))
const ProductDetail = lazy(() => import('./pages/ProductDetail'))
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
const AdminConsole = lazy(() => import('./pages/admin/AdminConsole'))

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1 },
  },
})

function PageFallback() {
  return (
    <div className="space-y-6">
      <SkeletonCard lines={3} />
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
              <Route path="/" element={<MemberHome><Dashboard /></MemberHome>} />
              <Route path="/profile/*" element={<Profile />} />
              <Route path="/network" element={<Network />} />
              <Route path="/genealogy" element={<Network />} />
              <Route path="/buy" element={<BuyProduct />} />
              <Route path="/buy/:id" element={<ProductDetail />} />
              <Route path="/pairs" element={<PairMatch />} />
              <Route path="/wallet" element={<Wallet />} />
              <Route path="/payouts" element={<PayoutHistory />} />
              <Route path="/directs" element={<DirectMembers />} />
              <Route path="/income" element={<IncomeReport />} />
              <Route path="/ranks" element={<RankRewards />} />
              <Route path="/support" element={<Support />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/admin/*" element={<RequireAdmin><AdminConsole /></RequireAdmin>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
