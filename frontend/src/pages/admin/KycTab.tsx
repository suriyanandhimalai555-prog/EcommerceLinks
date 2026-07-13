import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { ImageGallery } from '../../components/ui/ImageGallery'
import type { AdminMembersPage, AdminMemberRow, KycDocument } from '../../types/api'

type KycStatus = 'pending' | 'verified' | 'rejected'

export function KycTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<KycStatus>('pending')
  const [selected, setSelected] = useState<AdminMemberRow | null>(null)
  const [notes, setNotes] = useState('')
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)

  const { data: membersPage, isPending } = useQuery<AdminMembersPage>({
    queryKey: ['admin-kyc-queue', statusFilter],
    queryFn: () =>
      api.get(`/admin/members?kycStatus=${statusFilter}&limit=100`).then((r) => r.data),
  })
  const members = membersPage?.items ?? []

  const { data: kycDocs } = useQuery<KycDocument[]>({
    queryKey: ['admin-kyc-docs', selected?.id],
    queryFn: () =>
      api.get(`/admin/members/${selected!.id}/kyc-documents`).then((r) => r.data),
    enabled: !!selected,
  })

  const decide = useMutation({
    mutationFn: (status: KycStatus) =>
      api.post(`/admin/members/${selected!.id}/kyc`, {
        status,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (_, status) => {
      qc.invalidateQueries({ queryKey: ['admin-kyc-queue'] })
      qc.invalidateQueries({ queryKey: ['admin-members'] })
      qc.invalidateQueries({ queryKey: ['admin-overview'] })
      setBanner({ ok: true, text: `KYC marked ${status}` })
      setSelected(null)
      setNotes('')
    },
    onError: (err) =>
      setBanner({ ok: false, text: apiErrorMessage(err, t, 'Action failed') }),
  })

  const filterPills: { key: KycStatus; label: string }[] = [
    { key: 'pending', label: t('admin.kyc.filterPending') },
    { key: 'verified', label: t('admin.kyc.filterVerified') },
    { key: 'rejected', label: t('admin.kyc.filterRejected') },
  ]

  const columns: Column<AdminMemberRow>[] = [
    {
      key: 'code', header: 'Code',
      render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.memberCode}</span>,
    },
    { key: 'name', header: 'Name', render: (r) => <span className="text-sm font-medium text-ink">{r.name}</span> },
    { key: 'phone', header: 'Phone', render: (r) => <span className="text-xs text-ink-muted">{r.phone}</span> },
    {
      key: 'kyc', header: 'KYC Status',
      render: (r) =>
        r.kycStatus === 'verified' ? (
          <Badge size="sm" variant="success">{t('admin.kyc.filterVerified')}</Badge>
        ) : r.kycStatus === 'rejected' ? (
          <Badge size="sm" variant="danger">{t('admin.kyc.filterRejected')}</Badge>
        ) : r.hasDocuments ? (
          <Badge size="sm" variant="warning">{t('admin.kyc.statusAwaitingReview')}</Badge>
        ) : (
          <Badge size="sm" variant="neutral">{t('admin.kyc.statusNoDocs')}</Badge>
        ),
    },
    { key: 'joined', header: 'Joined', render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.createdAt)}</span> },
    {
      key: 'action', header: '', align: 'right',
      render: (r) => (
        <button
          onClick={() => { setSelected(r); setBanner(null); setNotes('') }}
          className="avg-btn-secondary py-1.5 px-3 text-xs"
        >
          {t('admin.kyc.review')}
        </button>
      ),
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-3">
        <h2 className="text-sm font-semibold text-ink mb-3">{t('admin.kyc.title')}</h2>
        <div className="flex gap-1 bg-white/5 p-1 rounded-lg w-fit">
          {filterPills.map((p) => (
            <button
              key={p.key}
              onClick={() => setStatusFilter(p.key)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all duration-200 cursor-pointer whitespace-nowrap ${
                statusFilter === p.key
                  ? 'bg-white/10 text-ink shadow-sm'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {banner && (
        <div className={`mx-5 mb-3 text-sm rounded-lg px-3 py-2 ${banner.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
          {banner.text}
        </div>
      )}

      <DataTable
        columns={columns}
        data={members ?? []}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle={t('admin.kyc.emptyTitle')}
        emptyDescription={t('admin.kyc.emptyDesc')}
      />

      <Modal
        open={!!selected}
        onClose={() => { setSelected(null); setNotes('') }}
        title={selected ? `${selected.name} — ${selected.memberCode}` : ''}
        size="lg"
      >
        {selected && (
          <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
            {/* Member info strip */}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-ink-muted">{selected.phone}</span>
              {selected.email && <span className="text-ink-muted">{selected.email}</span>}
              <span className="text-ink-muted">Joined {formatDate(selected.createdAt)}</span>
              <Badge
                size="sm"
                variant={selected.kycStatus === 'verified' ? 'success' : selected.kycStatus === 'rejected' ? 'danger' : 'neutral'}
              >
                {selected.kycStatus}
              </Badge>
            </div>

            {/* Documents */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">{t('admin.kyc.docsTitle')}</h3>
              {kycDocs && kycDocs.length > 0 ? (
                <div className="space-y-4">
                  <ImageGallery images={kycDocs} alt="KYC document" />
                  <div className="flex flex-wrap gap-2">
                    {kycDocs.map((d) => (
                      <a
                        key={d.id}
                        href={d.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <ExternalLink size={11} />
                        {d.docType.toUpperCase()}
                        {d.originalName ? ` — ${d.originalName}` : ''}
                        {' · '}{formatDate(d.uploadedAt)}
                      </a>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-warning">{t('admin.kyc.noDocs')}</p>
              )}
            </section>

            {/* Notes */}
            <section className="space-y-2">
              <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider">
                {t('admin.kyc.notesLabel')}
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </section>

            {/* Actions */}
            <div className="flex flex-wrap gap-2 border-t border-surface-line pt-4">
              <button
                onClick={() => decide.mutate('verified')}
                disabled={decide.isPending || (kycDocs != null && kycDocs.length === 0)}
                className="avg-btn-primary py-1.5 px-4 text-sm flex items-center gap-1.5"
              >
                {decide.isPending ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                {t('admin.kyc.approve')}
              </button>
              <button
                onClick={() => decide.mutate('rejected')}
                disabled={decide.isPending}
                className="avg-btn-danger text-sm"
              >
                {t('admin.kyc.reject')}
              </button>
              {selected.kycStatus !== 'pending' && (
                <button
                  onClick={() => decide.mutate('pending')}
                  disabled={decide.isPending}
                  className="flex items-center gap-1 bg-white/5 text-ink-muted font-semibold rounded-lg px-3 py-1.5 text-xs cursor-pointer hover:bg-white/10"
                >
                  {t('admin.kyc.resetPending')}
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
