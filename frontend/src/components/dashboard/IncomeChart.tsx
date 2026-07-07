import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts'
import { incomeChartData } from '../../data/mockData'

function formatY(value: number) {
  if (value >= 1000) return `${value / 1000}K`
  return `${value}`
}

export default function IncomeChart() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">Income Summary</h2>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={incomeChartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: '#9CA3AF' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={formatY}
            tick={{ fontSize: 11, fill: '#9CA3AF' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            formatter={(value) => [`₹${Number(value).toLocaleString()}`, '']}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E5E7EB' }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            formatter={(value) => {
              const labels: Record<string, string> = {
                pairMatch: 'Pair Match Income',
                direct: 'Direct Income',
                other: 'Other Income',
              }
              return labels[value] || value
            }}
          />
          <Line
            type="monotone"
            dataKey="pairMatch"
            stroke="#2563EB"
            strokeWidth={2}
            dot={{ r: 3, fill: '#2563EB' }}
            activeDot={{ r: 5 }}
          />
          <Line
            type="monotone"
            dataKey="direct"
            stroke="#16A34A"
            strokeWidth={2}
            dot={{ r: 3, fill: '#16A34A' }}
            activeDot={{ r: 5 }}
          />
          <Line
            type="monotone"
            dataKey="other"
            stroke="#EA580C"
            strokeWidth={2}
            dot={{ r: 3, fill: '#EA580C' }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
