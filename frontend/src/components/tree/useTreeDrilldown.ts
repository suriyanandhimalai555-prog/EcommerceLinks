import { useState } from 'react'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import api from '../../lib/api'
import type { TreeNode } from '../../types/api'

/**
 * Drives server-side drill-down for the binary genealogy tree.
 *
 * Each click calls /network/tree?root=<memberCode>&depth=N so that real
 * descendants load. The previous tree stays visible while the new data
 * is being fetched (keepPreviousData), and a back-stack lets the user
 * navigate back up the drill path.
 *
 * rootCode='me' is the sentinel that hits the caller's own tree root and
 * reuses the initial ['tree','me',depth] cache entry.
 */
export function useTreeDrilldown(depth: number) {
  const queryClient = useQueryClient()
  const [rootCode, setRootCode] = useState('me')
  const [stack, setStack] = useState<string[]>([])

  const query = useQuery<TreeNode>({
    queryKey: ['tree', rootCode, depth],
    queryFn: () =>
      api.get(`/network/tree?root=${rootCode}&depth=${depth}`).then((r) => r.data),
    placeholderData: keepPreviousData,
  })

  const drillTo = (code: string) => {
    if (code === rootCode) return
    setStack((s) => [...s, rootCode])
    setRootCode(code)
  }

  const back = () => {
    setStack((s) => {
      const prev = s.at(-1) ?? 'me'
      // The cached tree for `prev` may predate recent activations (global
      // staleTime keeps it "fresh" for 60s) — mark it stale so navigating
      // back triggers a background refetch while the cache renders instantly.
      queryClient.invalidateQueries({ queryKey: ['tree', prev, depth] })
      setRootCode(prev)
      return s.slice(0, -1)
    })
  }

  const backToMe = () => {
    queryClient.invalidateQueries({ queryKey: ['tree', 'me', depth] })
    setStack([])
    setRootCode('me')
  }

  return {
    root: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    drillTo,
    back,
    backToMe,
    canGoBack: stack.length > 0,
  }
}
