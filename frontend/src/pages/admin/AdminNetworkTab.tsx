import { useTranslation } from 'react-i18next'
import { BinaryTree } from '../../components/tree/BinaryTree'
import { useTreeDrilldown } from '../../components/tree/useTreeDrilldown'

/**
 * Management-only full-tree view. Reuses the same server-side drill-down hook
 * and BinaryTree component as the member Network page. For a management caller,
 * the backend resolves root='me' to the true tree root and skips the downline
 * authorization, so this renders the entire placement tree with drill-down.
 *
 * Scope is intentionally the binary tree only — the member Network page's
 * summary/donut/list widgets are downline-scoped and empty for an off-tree
 * management account.
 */
export function AdminNetworkTab() {
  const { t } = useTranslation()
  const { root: tree, isFetching, depth, requestDeeper, drillTo, back, backToMe, canGoBack } =
    useTreeDrilldown(3)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">{t('nav.adminNetwork')}</h1>
        <p className="text-sm text-ink-muted">Full binary placement tree from the root, with drill-down</p>
      </div>

      <div className="avg-card p-5 min-w-0">
        {tree ? (
          <BinaryTree
            root={tree}
            depth={depth}
            onNodeClick={drillTo}
            onBack={back}
            onBackToMe={backToMe}
            canGoBack={canGoBack}
            isFetching={isFetching}
            requestDeeper={requestDeeper}
          />
        ) : (
          <div className="py-10 text-center text-sm text-ink-muted">Loading tree…</div>
        )}
      </div>
    </div>
  )
}
