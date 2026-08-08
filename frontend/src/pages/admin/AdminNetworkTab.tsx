import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Trash2 } from 'lucide-react'
import { BinaryTree } from '../../components/tree/BinaryTree'
import { TreeSearch } from '../../components/tree/TreeSearch'
import { useTreeDrilldown } from '../../components/tree/useTreeDrilldown'
import { Modal } from '../../components/ui/Modal'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import type { AdminMembersPage } from '../../types/api'

/**
 * Management-only full-tree view. Reuses the same server-side drill-down hook
 * and BinaryTree component as the member Network page. For a management caller,
 * the backend resolves root='me' to the true tree root and skips the downline
 * authorization, so this renders the entire placement tree with drill-down.
 *
 * Delete affordance: inactive (orange) nodes show a trash icon. Clicking opens
 * a confirmation modal; on confirm the member is hard-deleted via
 * DELETE /admin/network/:memberCode (backend guards: not active, no downline,
 * no live orders). The tree cache is busted server-side so the Vacant slot
 * appears immediately.
 */
export function AdminNetworkTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { root: tree, isFetching, depth, requestDeeper, drillTo, back, backToMe, canGoBack } =
    useTreeDrilldown(3)

  const [deleteTarget, setDeleteTarget] = useState<{ code: string; name: string } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const del = useMutation({
    mutationFn: (code: string) => api.delete(`/admin/network/${code}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tree'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
      setDeleteTarget(null)
      setDeleteError(null)
    },
    onError: (err) => {
      setDeleteError(apiErrorMessage(err, t, t('tree.deleteFailed')))
    },
  })

  const handleDeleteRequest = (code: string, name: string) => {
    setDeleteError(null)
    setDeleteTarget({ code, name })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">{t('nav.adminNetwork')}</h1>
        <p className="text-sm text-ink-muted">Full binary placement tree from the root, with drill-down</p>
      </div>

      <div className="avg-card p-5 min-w-0">
        <TreeSearch
          scope="admin-members"
          placeholder={t('tree.searchPlaceholder')}
          onSelect={drillTo}
          fetchResults={async (query) => {
            const r = await api.get<AdminMembersPage>(`/admin/members?q=${encodeURIComponent(query)}&page=1&limit=8`)
            return r.data.items
              // Skip the off-tree management account — it has no placement subtree.
              .filter((m) => m.role !== 'management')
              .map((m) => ({
                memberCode: m.memberCode,
                name: m.name,
                meta: m.isActive ? t('counters.active') : t('admin.earnings.inactive'),
              }))
          }}
        />
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
            onDelete={handleDeleteRequest}
          />
        ) : (
          <div className="py-10 text-center text-sm text-ink-muted">Loading tree…</div>
        )}
      </div>

      {/* Delete confirmation modal */}
      <Modal
        open={!!deleteTarget}
        title={t('tree.deleteConfirmTitle')}
        onClose={() => { setDeleteTarget(null); setDeleteError(null) }}
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            {t('tree.deleteConfirmBody', { name: deleteTarget?.name ?? '' })}
          </p>

          {deleteError && (
            <div className="flex items-start gap-2 bg-danger/10 border border-danger/20 rounded-lg p-3">
              <p className="text-xs text-danger">{deleteError}</p>
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              className="avg-btn-secondary px-4 py-2 text-sm"
              onClick={() => { setDeleteTarget(null); setDeleteError(null) }}
              disabled={del.isPending}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="flex items-center gap-1.5 bg-danger hover:bg-danger/90 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
              onClick={() => deleteTarget && del.mutate(deleteTarget.code)}
              disabled={del.isPending}
            >
              {del.isPending
                ? <Loader2 size={14} className="animate-spin" />
                : <Trash2 size={14} />}
              {t('tree.delete')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
