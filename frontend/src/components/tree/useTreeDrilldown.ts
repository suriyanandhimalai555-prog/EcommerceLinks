import { useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
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
      setRootCode(prev)
      return s.slice(0, -1)
    })
  }

  const backToMe = () => {
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
