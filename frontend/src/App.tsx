import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AppShell from './components/layout/AppShell'
import { RequireAuth } from './routes/guard'
import Login from './pages/auth/Login'
import Register from './pages/auth/Register'
import Dashboard from './pages/Dashboard'
import Network from './pages/Network'
import BuyProduct from './pages/BuyProduct'
import Profile from './pages/Profile'
import Wallet from './pages/Wallet'
import PayoutHistory from './pages/PayoutHistory'
import PairMatch from './pages/PairMatch'
import IncomeReport from './pages/IncomeReport'
import RankRewards from './pages/RankRewards'
import DirectMembers from './pages/DirectMembers'
import Notifications from './pages/Notifications'
import Support from './pages/Support'
import Settings from './pages/Settings'

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1 },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
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
      </BrowserRouter>
    </QueryClientProvider>
  )
}
