import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Search, Loader2 } from 'lucide-react'

export interface TreeSearchResult {
  memberCode: string
  name: string
  /** Small right-aligned hint, e.g. "L3 · R" or "Active". */
  meta?: string
}

interface TreeSearchProps {
  /** Called with the chosen member code — wire to useTreeDrilldown's drillTo. */
  onSelect: (memberCode: string) => void
  /** Fetch matches for a query (page-specific: downline vs all-members). */
  fetchResults: (q: string) => Promise<TreeSearchResult[]>
  /**
   * Disambiguates the react-query cache between data sources. Two instances with
   * different fetchResults MUST pass different scopes, otherwise (queryKey omits
   * the queryFn + global staleTime) the same query string would return one
   * source's cached results on the other tree.
   */
  scope: string
  placeholder?: string
}

/**
 * Debounced search box that navigates the binary tree to a member. Typing shows
 * a dropdown of matches; clicking one calls onSelect(memberCode) which re-roots
 * the tree at that member via the existing drill-down mechanism.
 *
 * Decoupled from response shape: each page passes its own fetchResults so the
 * member page can search its downline (/network/downline) and the admin page
 * can search all members (/admin/members).
 */
export function TreeSearch({ onSelect, fetchResults, scope, placeholder }: TreeSearchProps) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounce the query (matches the 350ms pattern used elsewhere on the page).
  useEffect(() => {
    const id = setTimeout(() => setQ(input.trim()), 350)
    return () => clearTimeout(id)
  }, [input])

  const enabled = q.length >= 2
  const { data: results = [], isFetching } = useQuery<TreeSearchResult[]>({
    queryKey: ['tree-search', scope, q],
    queryFn: () => fetchResults(q),
    enabled,
  })

  const choose = (memberCode: string) => {
    onSelect(memberCode)
    setInput('')
    setQ('')
    setOpen(false)
  }

  const showDropdown = open && enabled

  return (
    <div className="relative max-w-md mb-3">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" />
      <input
        value={input}
        onChange={(e) => { setInput(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150) }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Enter' && results[0]) choose(results[0].memberCode)
        }}
        placeholder={placeholder ?? t('tree.searchPlaceholder')}
        className="w-full rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-9 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
      />
      {isFetching && (
        <Loader2 size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted animate-spin" />
      )}

      {showDropdown && (
        <div
          className="absolute z-20 left-0 right-0 mt-1 rounded-lg border border-surface-line bg-[#151A28] shadow-lg overflow-hidden"
          // Keep focus on input while clicking a row so onBlur doesn't fire first.
          onMouseDown={(e) => { e.preventDefault(); if (blurTimer.current) clearTimeout(blurTimer.current) }}
        >
          {results.length > 0 ? (
            <ul className="max-h-72 overflow-y-auto py-1">
              {results.map((r) => (
                <li key={r.memberCode}>
                  <button
                    type="button"
                    onClick={() => choose(r.memberCode)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink truncate">{r.name}</span>
                      <span className="block font-mono text-[11px] text-ink-muted">{r.memberCode}</span>
                    </span>
                    {r.meta && <span className="text-[11px] text-ink-muted whitespace-nowrap">{r.meta}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            !isFetching && (
              <div className="px-3 py-3 text-sm text-ink-muted">{t('tree.searchNoResults')}</div>
            )
          )}
        </div>
      )}
    </div>
  )
}
