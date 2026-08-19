import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, Trash2 } from 'lucide-react'
import { BinaryTree } from '../../components/tree/BinaryTree'
import { TreeSearch } from '../../components/tree/TreeSearch'
import { useTreeDrilldown } from '../../components/tree/useTreeDrilldown'
import { Modal } from '../../components/ui/Modal'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { downloadCsv } from '../../lib/exportCsv'
import { formatDate } from '../../lib/format'
import type { AdminDownlineExport, AdminMembersPage } from '../../types/api'

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
const SELECT_CLS =
  'rounded-lg border border-surface-line bg-[#10141F] px-3 py-1.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary cursor-pointer'

export function AdminNetworkTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { root: tree, isFetching, depth, requestDeeper, drillTo, back, backToMe, canGoBack } =
    useTreeDrilldown(3)

  const [deleteTarget, setDeleteTarget] = useState<{ code: string; name: string } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // ── Export state ──
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [kycFilter, setKycFilter] = useState<'all' | 'done' | 'notdone'>('all')
  const [bankFilter, setBankFilter] = useState<'all' | 'done' | 'notdone'>('all')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // Export the entire downline of the currently displayed tree root.
  // Uses the dedicated management-only endpoint which performs a single
  // GIN-indexed placement_path containment query on the backend.
  const exportCSV = async () => {
    if (!tree) return
    // The 'me' sentinel resolves to the tree root; the memberCode on the node
    // is always the real code once the tree has loaded, so this is always valid.
    const rootCode = tree.memberCode
    setExporting(true)
    setExportError(null)
    try {
      const params = new URLSearchParams()
      if (activeFilter !== 'all') params.set('active', activeFilter)
      if (kycFilter !== 'all')    params.set('kyc', kycFilter)
      if (bankFilter !== 'all')   params.set('bank', bankFilter)

      const res = await api
        .get<AdminDownlineExport>(`/admin/network/${rootCode}/downline/export?${params}`)
        .then((r) => r.data)

      const headers = [
        t('adminNetwork.colMemberCode'),
        t('adminNetwork.colName'),
        t('adminNetwork.colPhone'),
        t('adminNetwork.colEmail'),
        t('adminNetwork.colSponsorCode'),
        t('adminNetwork.colSponsorName'),
        t('adminNetwork.colLevel'),
        t('adminNetwork.colLeg'),
        t('adminNetwork.colActive'),
        t('adminNetwork.colQualified'),
        t('adminNetwork.colKyc'),
        t('adminNetwork.colBank'),
        t('adminNetwork.colJoined'),
      ]

      const rows = res.rows.map((r) => [
        r.memberCode,
        r.name,
        r.phone,
        r.email ?? '',
        r.sponsorCode ?? '',
        r.sponsorName ?? '',
        r.level,
        r.leg ?? '-',
        r.isActive ? 'Active' : 'Inactive',
        r.isQualified ? 'Yes' : 'No',
        r.kycStatus,
        r.bankStatus,
        formatDate(r.joinedAt),
      ])

      // File named for the exported person — management can tell exports apart at a glance.
      const safeName = res.root.name.replace(/[^\w-]+/g, '_')
      downloadCsv(
        `downline-${res.root.memberCode}-${safeName}-${new Date().toISOString().slice(0, 10)}.csv`,
        headers,
        rows,
      )
    } catch {
      setExportError('Export failed. Please try again.')
    } finally {
      setExporting(false)
    }
  }

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

      {/* ── Downline export card (management-only; this whole tab is management-only) ── */}
      <div className="avg-card p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">{t('adminNetwork.exportTitle')}</h2>
          <p className="text-xs text-ink-muted mt-0.5">{t('adminNetwork.exportSubtitle')}</p>
        </div>

        {/* Current target indicator */}
        <div className="text-xs text-ink-muted">
          <span className="font-medium text-ink">{t('adminNetwork.currentTarget')}:</span>{' '}
          {tree
            ? <span className="text-primary font-semibold">{tree.name} ({tree.memberCode})</span>
            : <span className="italic">{t('adminNetwork.noTarget')}</span>}
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-muted whitespace-nowrap">{t('adminNetwork.filterStatus')}</span>
            <select
              value={activeFilter}
              onChange={(e) => setActiveFilter(e.target.value as typeof activeFilter)}
              className={SELECT_CLS}
            >
              <option value="all">{t('adminNetwork.filterStatusAll')}</option>
              <option value="active">{t('adminNetwork.filterStatusActive')}</option>
              <option value="inactive">{t('adminNetwork.filterStatusInactive')}</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-muted whitespace-nowrap">{t('adminNetwork.filterKyc')}</span>
            <select
              value={kycFilter}
              onChange={(e) => setKycFilter(e.target.value as typeof kycFilter)}
              className={SELECT_CLS}
            >
              <option value="all">{t('adminNetwork.filterKycAll')}</option>
              <option value="done">{t('adminNetwork.filterKycDone')}</option>
              <option value="notdone">{t('adminNetwork.filterKycNotDone')}</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-muted whitespace-nowrap">{t('adminNetwork.filterBank')}</span>
            <select
              value={bankFilter}
              onChange={(e) => setBankFilter(e.target.value as typeof bankFilter)}
              className={SELECT_CLS}
            >
              <option value="all">{t('adminNetwork.filterBankAll')}</option>
              <option value="done">{t('adminNetwork.filterBankDone')}</option>
              <option value="notdone">{t('adminNetwork.filterBankNotDone')}</option>
            </select>
          </div>

          <button
            onClick={exportCSV}
            disabled={!tree || exporting}
            className="flex items-center gap-1.5 avg-btn-primary disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
          >
            {exporting
              ? <Loader2 size={14} className="animate-spin" />
              : <Download size={14} />}
            {exporting ? t('adminNetwork.exporting') : t('adminNetwork.exportBtn')}
          </button>
        </div>

        {exportError && (
          <p className="text-xs text-danger">{exportError}</p>
        )}
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
