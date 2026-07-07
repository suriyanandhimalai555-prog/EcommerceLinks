import { useState, useMemo } from 'react'
import { Download } from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { formatINR, formatDate } from '../lib/format'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import type { Dashboard, LedgerRes } from '../types/api'

const PRESETS = [7, 30, 90] as const
type Preset = typeof PRESETS[number]

export default function IncomeReport() {
  const [preset, setPreset] = useState<Preset>(30)

  const { data: dash } = useQuery<Dashboard>({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard').then((r) => r.data) })
  const { data: ledger } = useQuery<LedgerRes>({ queryKey: ['ledger-report'], queryFn: () => api.get('/wallet/ledger?limit=100').then((r) => r.data) })

  const chartData = useMemo(() => {
    const series = (dash?.incomeSeries ?? [])
    const cutoff = Date.now() - preset * 24 * 60 * 60 * 1000
    return series
      .filter(s => new Date(s.date).getTime() >= cutoff)
      .map(s => ({
        date: new Date(s.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        income: s.pairPaise / 100,
      }))
  }, [preset, dash])

  const total = chartData.reduce((a, b) => a + b.income, 0)

  const exportCSV = () => {
    const headers = ['Date', 'Description', 'Direction', 'Amount (₹)']
    const rows = (ledger?.items ?? []).map(r => [formatDate(r.at), r.description, r.direction, formatINR(r.amountPaise)])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'income-report.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">Income Report</h1>
          <p className="text-sm text-ink-muted">Pair match income analysis</p>
        </div>
        <button onClick={exportCSV} className="avg-btn-secondary self-start sm:self-auto">
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Preset selector */}
      <div className="flex gap-2">
        {PRESETS.map(p => (
          <button
            key={p}
            onClick={() => setPreset(p)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer ${
              preset === p ? 'bg-primary text-white shadow-sm' : 'bg-white border border-surface-line hover:border-primary text-ink-muted hover:text-primary'
            }`}
          >
            Last {p} days
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="avg-card p-5">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1">Total for period</p>
          <p className="text-2xl sm:text-3xl font-bold text-primary">{formatINR(total * 100)}</p>
          <p className="text-xs text-ink-muted mt-1">Pair match income only</p>
        </div>
        <div className="avg-card p-5">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1">Daily Average</p>
          <p className="text-2xl sm:text-3xl font-bold text-success">{formatINR((total / preset) * 100)}</p>
          <p className="text-xs text-ink-muted mt-1">per day over {preset} days</p>
        </div>
      </div>

      {/* Chart */}
      <div className="avg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ink">Pair Income Trend</h2>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-primary" />
            <span className="text-xs text-ink-muted">Pair Match Income</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="incomeGrad2" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#2447D8" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#2447D8" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} interval={Math.floor(chartData.length / 8)} />
            <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} tickFormatter={v => `₹${(v/1000).toFixed(0)}K`} />
            <Tooltip formatter={(v) => [formatINR(Number(v) * 100), 'Income']} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E5E7EB' }} />
            <Area type="monotone" dataKey="income" stroke="#2447D8" strokeWidth={2.5} fill="url(#incomeGrad2)" dot={false} activeDot={{ r: 4, fill: '#2447D8' }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Ledger */}
      <div className="avg-card p-5">
        <h2 className="text-sm font-semibold text-ink mb-4">Transaction Ledger</h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-line">
                {['Date', 'Description', 'Direction', 'Amount'].map(h => (
                  <th key={h} className="px-4 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wider text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(ledger?.items ?? []).map((r, i) => (
                <tr key={i} className="border-b border-surface-line last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-xs text-ink-muted">{formatDate(r.at)}</td>
                  <td className="px-4 py-3 text-sm font-medium">{r.description}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-semibold ${r.direction === 'credit' ? 'text-success' : 'text-danger'}`}>
                      {r.direction}
                    </span>
                  </td>
                  <td className={`px-4 py-3 text-sm font-bold text-right ${r.direction === 'credit' ? 'text-success' : 'text-danger'}`}>
                    {r.direction === 'credit' ? '+' : '-'}{formatINR(r.amountPaise)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-primary-50">
                <td colSpan={3} className="px-4 py-3 text-sm font-semibold text-ink">Total Credits</td>
                <td className="px-4 py-3 text-sm font-bold text-success text-right">
                  +{formatINR((ledger?.items ?? []).filter(r => r.direction === 'credit').reduce((a, b) => a + b.amountPaise, 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}
