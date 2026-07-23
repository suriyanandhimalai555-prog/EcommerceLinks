import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from './api'
import { formatINR } from './format'
import type { Dashboard, Me, RankLevel } from '../types/api'

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
 *
 * "Read" state is tracked server-side via members.notifications_seen_at (set by
 * POST /me/notifications/seen). A notification is read iff its `at` is <=
 * that timestamp. Because the timestamp lives in the database, clearing the
 * bell on one device clears it everywhere — cross-device consistent.
 *
 * The ['me'] query is the reactive backing: markAllRead() posts to the server
 * and updates the cache directly, so the bell and the Notifications page both
 * re-render in the same tick without an extra refetch.
 */
export function useNotifications(enabled = true) {
  const queryClient = useQueryClient()

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
    enabled,
  })
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

  // Server-side last-seen timestamp — null means never seen (all unread).
  const lastSeenAt = me?.notificationsSeenAt ?? null

  const txs = dash?.recentTransactions
  const ranks = rankData?.levels

  const notifications: AppNotification[] = useMemo(() => {
    const walletNotifs: AppNotification[] = (txs ?? [])
      .filter((tx) => tx.direction === 'credit')
      .map((tx) => ({
        id: `tx-${tx.at}`,
        type: 'wallet',
        title: tx.type === 'pair_bonus' ? 'Pair Match Bonus' : 'Credit',
        description: `${formatINR(tx.amountPaise)} credited to your wallet`,
        at: tx.at,
        read: lastSeenAt != null && tx.at <= lastSeenAt,
      }))

    const rankNotifs: AppNotification[] = (ranks ?? [])
      .filter((r) => r.achieved)
      .map((r) => ({
        id: `rank-${r.level}`,
        type: 'rank',
        title: `Rank Achieved: ${r.name}`,
        description: `Congratulations! You achieved Level ${r.level}`,
        at: r.achievedAt || '',
        read: lastSeenAt != null && (r.achievedAt ?? '') !== '' && (r.achievedAt ?? '') <= lastSeenAt,
      }))

    return [...walletNotifs, ...rankNotifs].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    )
  }, [txs, ranks, lastSeenAt])

  const unread = notifications.filter((n) => !n.read).length

  // Posts to the server and writes the returned Me directly into the shared
  // ['me'] cache so both the bell (Topbar) and the list (Notifications page)
  // re-render immediately. Stable identity so the useEffect in Notifications.tsx
  // doesn't loop.
  const markAllRead = useCallback(() => {
    api.post('/me/notifications/seen')
      .then((r) => queryClient.setQueryData(['me'], r.data))
      .catch(() => {
        // Best-effort — if the request fails the badge stays up; it will
        // reconcile on the next ['me'] refetch (e.g. window focus).
      })
  }, [queryClient])

  return { notifications, unread, markAllRead }
}
