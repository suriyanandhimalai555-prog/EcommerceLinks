import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from './api'
import { formatINR } from './format'
import type { Dashboard, RankLevel } from '../types/api'

export interface AppNotification {
  id: string
  type: 'wallet' | 'rank'
  title: string
  description: string
  at: string
  read: boolean
}

/**
 * Notifications are derived client-side from wallet credits (last dashboard
 * transactions) and achieved ranks — there is no dedicated backend feed yet.
 * Shared by the Notifications page and the topbar bell so both agree.
 */
export function useNotifications(enabled = true) {
  const { data: dash } = useQuery<Dashboard>({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/dashboard').then((r) => r.data),
    enabled,
  })
  const { data: rankData } = useQuery<{ levels: RankLevel[] }>({
    queryKey: ['ranks'],
    queryFn: () => api.get('/ranks/progress').then((r) => r.data),
    enabled,
  })

  const txs = dash?.recentTransactions
  const ranks = rankData?.levels

  const notifications: AppNotification[] = useMemo(() => {
    const walletNotifs: AppNotification[] = (txs ?? [])
      .filter((tx) => tx.direction === 'credit')
      .map((tx, i) => ({
        id: `tx-${i}`,
        type: 'wallet',
        title: tx.type === 'pair_bonus' ? 'Pair Match Bonus' : 'Credit',
        description: `${formatINR(tx.amountPaise)} credited to your wallet`,
        at: tx.at,
        read: i > 1,
      }))

    const rankNotifs: AppNotification[] = (ranks ?? [])
      .filter((r) => r.achieved)
      .map((r) => ({
        id: `rank-${r.level}`,
        type: 'rank',
        title: `Rank Achieved: ${r.name}`,
        description: `Congratulations! You achieved Level ${r.level}`,
        at: r.achievedAt || '',
        read: true,
      }))

    return [...walletNotifs, ...rankNotifs].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    )
  }, [txs, ranks])

  const unread = notifications.filter((n) => !n.read).length
  return { notifications, unread }
}
