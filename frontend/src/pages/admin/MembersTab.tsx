import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Search, Loader2, ShieldCheck, ShieldOff, KeyRound, Wallet, UserCog, AlertTriangle } from 'lucide-react'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { isManagement } from '../../lib/roles'
import { formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { FormField } from '../../components/ui/FormField'
import type { AdminKycDetail, AdminMembersPage, AdminMemberRow, KycDocument, Me } from '../../types/api'

export function MembersTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<AdminMemberRow | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // form state for the action modal
  const [contact, setContact] = useState({ name: '', email: '', phone: '' })
  const [bankForm, setBankForm] = useState({ accountName: '', accountNumber: '', ifsc: '' })
  const [adjust, setAdjust] = useState({ rupees: '', direction: 'credit' as 'credit' | 'debit', notes: '' })
  const [newPassword, setNewPassword] = useState('')
  // Grant-admin type-to-confirm guard: the Grant button opens this modal, and the
  // final grant is disabled until the operator types the member's code.
  const [grantConfirm, setGrantConfirm] = useState(false)
  const [confirmCode, setConfirmCode] = useState('')

  useEffect(() => {
    const t = setTimeout(() => { setQ(input); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [input])

  const { data: me } = useQuery<Me>({ queryKey: ['me'], queryFn: () => api.get('/me').then((r) => r.data) })
  const { data: kycDocs } = useQuery<KycDocument[]>({
    queryKey: ['admin-kyc-docs', selected?.id],
    queryFn: () => api.get(`/admin/members/${selected!.id}/kyc-documents`).then((r) => r.data),
    enabled: !!selected,
  })
  const { data: kycDetail } = useQuery<AdminKycDetail>({
    queryKey: ['admin-kyc-detail', selected?.id],
    queryFn: () => api.get(`/admin/members/${selected!.id}/kyc-detail`).then((r) => r.data),
    enabled: !!selected,
  })
  // Seed bankForm fields when kycDetail arrives (it loads after modal opens)
  useEffect(() => {
    if (kycDetail) {
      setBankForm({
        accountName: kycDetail.bankAccountName ?? '',
        accountNumber: kycDetail.bankAccountNumber ?? '',
        ifsc: kycDetail.bankIfsc ?? '',
      })
    }
  }, [kycDetail])
  const PAGE_SIZE = 20
  const { data, isPending } = useQuery<AdminMembersPage>({
    queryKey: ['admin-members', q, page],
    queryFn: () =>
      api.get(`/admin/members?q=${encodeURIComponent(q)}&page=${page}&limit=${PAGE_SIZE}`).then((r) => r.data),
    placeholderData: keepPreviousData,
  })
  const members = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const openMember = (m: AdminMemberRow) => {
    setSelected(m)
    setMsg(null)
    setContact({ name: m.name, email: m.email ?? '', phone: m.phone })
    setAdjust({ rupees: '', direction: 'credit', notes: '' })
    setNewPassword('')
  }

  const refresh = (text: string) => {
    qc.invalidateQueries({ queryKey: ['admin-members'] })
    qc.invalidateQueries({ queryKey: ['admin-overview'] })
    setMsg({ ok: true, text })
  }
  const fail = (err: unknown) => setMsg({ ok: false, text: apiErrorMessage(err, t, 'Action failed') })

  const saveContact = useMutation({
    mutationFn: () => api.patch(`/admin/members/${selected!.id}`, {
      name: contact.name,
      // Always send lowercase — mirrors backend normalisation; never send null (column is NOT NULL).
      email: contact.email.trim().toLowerCase(),
      phone: contact.phone,
    }),
    onSuccess: () => refresh('Contact details saved'),
    onError: fail,
  })

  // Basic email shape check — mirrors the Zod schema on the backend (x@y.z minimum).
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())
  const setBank = useMutation({
    mutationFn: (status: 'verified' | 'pending') => api.post(`/admin/members/${selected!.id}/bank`, { status }),
    // Fix: sync selected state so the badge updates immediately (same pattern as setBlocked/setRole)
    onSuccess: (_, status) => { refresh(`Bank marked ${status}`); setSelected((s) => (s ? { ...s, bankStatus: status } : s)) },
    onError: fail,
  })
  const saveBankDetails = useMutation({
    mutationFn: () => api.put(`/admin/members/${selected!.id}/bank-details`, bankForm),
    onSuccess: () => { refresh('Bank details saved'); qc.invalidateQueries({ queryKey: ['admin-kyc-detail', selected!.id] }) },
    onError: fail,
  })
  const applyAdjustment = useMutation({
    mutationFn: () => api.post(`/admin/members/${selected!.id}/adjustment`, {
      amountPaise: Math.round(parseFloat(adjust.rupees) * 100),
      direction: adjust.direction,
      notes: adjust.notes,
    }),
    onSuccess: () => { refresh(`Wallet ${adjust.direction} applied`); setAdjust({ rupees: '', direction: 'credit', notes: '' }) },
    onError: fail,
  })
  const resetPassword = useMutation({
    mutationFn: () => api.post(`/admin/members/${selected!.id}/reset-password`, { newPassword }),
    onSuccess: () => { refresh('Password reset'); setNewPassword('') },
    onError: fail,
  })
  const setBlocked = useMutation({
    mutationFn: (blocked: boolean) => api.post(`/admin/members/${selected!.id}/block`, { blocked }),
    onSuccess: (_, blocked) => { refresh(blocked ? 'Member blocked' : 'Member unblocked'); setSelected((s) => (s ? { ...s, blocked } : s)) },
    onError: fail,
  })
  const setRole = useMutation({
    mutationFn: (role: 'member' | 'admin') => api.post(`/admin/members/${selected!.id}/role`, { role }),
    onSuccess: (_, role) => {
      refresh(`Role set to ${role}`)
      setSelected((s) => (s ? { ...s, role } : s))
      setGrantConfirm(false)
      setConfirmCode('')
    },
    onError: fail,
  })

  const columns: Column<AdminMemberRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.memberCode}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="text-sm font-medium text-ink">{r.name}</span> },
    {
      key: 'sponsor', header: 'Sponsor',
      render: (r) => r.sponsorCode
        ? <div className="leading-tight">
            <div className="font-mono text-xs font-semibold text-ink">{r.sponsorCode}</div>
            <div className="text-xs text-ink-muted">{r.sponsorName}</div>
          </div>
        : <span className="text-xs text-ink-muted">—</span>,
    },
    { key: 'phone', header: 'Phone', render: (r) => <span className="text-xs text-ink-muted">{r.phone}</span> },
    {
      key: 'role', header: 'Role',
      render: (r) => r.role === 'management'
        ? <Badge variant="violet" size="sm">management</Badge>
        : r.role === 'admin' ? <Badge variant="primary" size="sm">admin</Badge> : <span className="text-xs text-ink-muted">member</span>,
    },
    { key: 'kyc', header: 'KYC', render: (r) => <Badge size="sm" variant={r.kycStatus === 'verified' ? 'success' : r.kycStatus === 'rejected' ? 'danger' : 'neutral'}>{r.kycStatus}</Badge> },
    { key: 'bank', header: 'Bank', render: (r) => <Badge size="sm" variant={r.bankStatus === 'verified' ? 'success' : r.bankStatus === 'rejected' ? 'danger' : 'neutral'}>{r.bankStatus}</Badge> },
    {
      key: 'state', header: 'Status',
      render: (r) => r.blocked
        ? <Badge variant="danger" size="sm">blocked</Badge>
        : r.isActive ? <Badge variant="success" size="sm">active</Badge> : <Badge variant="neutral" size="sm">inactive</Badge>,
    },
    { key: 'joined', header: 'Joined', render: (r) => <span className="text-xs text-ink-muted">{formatDate(r.createdAt)}</span> },
    {
      key: 'manage', header: '', align: 'right',
      render: (r) => <button onClick={() => openMember(r)} className="avg-btn-secondary py-1.5 px-3 text-xs"><UserCog size={12} /> Manage</button>,
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-3">
        <h2 className="text-sm font-semibold text-ink mb-3">Members</h2>
        <div className="relative max-w-md">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search by name, phone or member code…"
            className="w-full rounded-lg border border-surface-line bg-[#10141F] pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
        </div>
      </div>
      <DataTable
        columns={columns}
        data={members}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle="No members found"
        emptyDescription="Try a different search"
      />

      {total > 0 && (
        <div className="px-5 py-3 border-t border-surface-line flex items-center justify-between gap-4 flex-wrap">
          <span className="text-xs text-ink-muted">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} members
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => p - 1)}
              disabled={page === 1}
              className="avg-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
            >
              ‹ Prev
            </button>
            <span className="px-3 text-xs font-medium text-ink">{page} / {totalPages}</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages}
              className="avg-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
            >
              Next ›
            </button>
          </div>
        </div>
      )}

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? `${selected.name} — ${selected.memberCode}` : ''} size="lg">
        {selected && (
          <div className="space-y-5 max-h-[65vh] overflow-y-auto pr-1">
            {msg && (
              <div className={`text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
                {msg.text}
              </div>
            )}

            {/* Referred by */}
            <div className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
              <span className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Referred by</span>
              {selected.sponsorCode
                ? <span className="text-sm text-ink"><span className="font-mono font-semibold">{selected.sponsorCode}</span> — {selected.sponsorName}</span>
                : <span className="text-sm text-ink-muted">—</span>}
            </div>

            {/* Contact */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Contact details</h3>
              <FormField label="Name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
                <FormField label="Phone" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
              </div>
              <button
                onClick={() => saveContact.mutate()}
                disabled={saveContact.isPending || !emailValid || !contact.name.trim()}
                className="avg-btn-secondary py-2 text-xs"
              >
                {saveContact.isPending ? <Loader2 size={12} className="animate-spin" /> : null} Save contact
              </button>
            </section>

            {/* Verification */}
            <section className="space-y-2 border-t border-surface-line pt-4">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Verification</h3>
              {/* Uploaded KYC documents (private S3, short-lived presigned URLs) */}
              {kycDocs && kycDocs.length > 0 ? (
                <div className="flex flex-wrap gap-3 pb-1">
                  {kycDocs.map((d) => (
                    <a key={d.id} href={d.url} target="_blank" rel="noreferrer" className="block w-20 text-center group">
                      <img
                        src={d.url}
                        alt={d.docType}
                        className="w-20 h-20 rounded-lg object-cover border border-surface-line group-hover:border-primary transition-colors"
                      />
                      <span className="text-[10px] text-ink-muted uppercase">{d.docType}</span>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-warning">{t('admin.members.noDocsWarning')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-muted w-14">KYC</span>
                <Badge size="sm" variant={selected.kycStatus === 'verified' ? 'success' : selected.kycStatus === 'rejected' ? 'danger' : 'neutral'}>{selected.kycStatus}</Badge>
                <span className="text-xs text-ink-muted">{t('admin.members.kycReadOnly')}</span>
              </div>
              {/* Bank details — editable by management + status toggle */}
              <div className="space-y-3 border-t border-surface-line pt-3">
                <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-2">
                  {t('admin.kyc.bankTitle')}
                  <Badge size="sm" variant={selected.bankStatus === 'verified' ? 'success' : 'neutral'}>
                    {selected.bankStatus}
                  </Badge>
                </h4>
                <FormField
                  label={t('admin.kyc.accountName')}
                  value={bankForm.accountName}
                  onChange={(e) => setBankForm({ ...bankForm, accountName: e.target.value })}
                  placeholder="Full name as per bank"
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    label={t('admin.kyc.accountNumber')}
                    value={bankForm.accountNumber}
                    onChange={(e) => setBankForm({ ...bankForm, accountNumber: e.target.value })}
                    placeholder="Account number"
                  />
                  <FormField
                    label={t('admin.kyc.ifscLabel')}
                    value={bankForm.ifsc}
                    onChange={(e) => setBankForm({ ...bankForm, ifsc: e.target.value.toUpperCase() })}
                    placeholder="SBIN0001234"
                  />
                </div>
                <button
                  onClick={() => saveBankDetails.mutate()}
                  disabled={saveBankDetails.isPending || !bankForm.accountName.trim() || !bankForm.accountNumber.trim() || !bankForm.ifsc.trim()}
                  className="avg-btn-secondary py-2 text-xs"
                >
                  {saveBankDetails.isPending ? <Loader2 size={12} className="animate-spin" /> : null} Save bank details
                </button>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button onClick={() => setBank.mutate('verified')} disabled={setBank.isPending} className="avg-btn-secondary py-1.5 px-3 text-xs"><ShieldCheck size={12} /> Verify</button>
                  <button onClick={() => setBank.mutate('pending')} disabled={setBank.isPending} className="flex items-center gap-1 bg-white/5 text-ink-muted font-semibold rounded-lg px-3 py-1.5 text-xs cursor-pointer hover:bg-white/10 disabled:opacity-40">Reset to pending</button>
                </div>
              </div>
            </section>

            {/* Wallet adjustment */}
            <section className="space-y-3 border-t border-surface-line pt-4">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider flex items-center gap-1.5"><Wallet size={12} /> Wallet adjustment</h3>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Amount (₹)" type="number" min="0" step="0.01" value={adjust.rupees} onChange={(e) => setAdjust({ ...adjust, rupees: e.target.value })} />
                <div>
                  <label className="block text-sm font-medium text-ink mb-1.5">Direction</label>
                  <select
                    value={adjust.direction}
                    onChange={(e) => setAdjust({ ...adjust, direction: e.target.value as 'credit' | 'debit' })}
                    className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="credit">Credit (add)</option>
                    <option value="debit">Debit (remove)</option>
                  </select>
                </div>
              </div>
              <FormField label="Reason (required, audit-logged)" value={adjust.notes} onChange={(e) => setAdjust({ ...adjust, notes: e.target.value })} />
              <button
                onClick={() => applyAdjustment.mutate()}
                disabled={applyAdjustment.isPending || !adjust.notes || !(parseFloat(adjust.rupees) > 0)}
                className="avg-btn-secondary py-2 text-xs"
              >
                {applyAdjustment.isPending ? <Loader2 size={12} className="animate-spin" /> : null} Apply adjustment
              </button>
            </section>

            {/* Access */}
            <section className="space-y-3 border-t border-surface-line pt-4">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Access</h3>
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <FormField label="New password (min 8 chars)" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                </div>
                <button onClick={() => resetPassword.mutate()} disabled={resetPassword.isPending || newPassword.length < 8} className="avg-btn-secondary py-2.5 text-xs whitespace-nowrap">
                  <KeyRound size={12} /> Reset password
                </button>
              </div>
              {selected.role !== 'management' && (
                <div className="flex flex-wrap gap-2">
                  {selected.blocked ? (
                    <button onClick={() => setBlocked.mutate(false)} disabled={setBlocked.isPending} className="avg-btn-secondary py-1.5 px-3 text-xs"><ShieldCheck size={12} /> Unblock login</button>
                  ) : (
                    <button onClick={() => setBlocked.mutate(true)} disabled={setBlocked.isPending} className="avg-btn-danger"><ShieldOff size={12} /> Block login</button>
                  )}
                  {isManagement(me) && (
                    selected.role === 'admin'
                      ? <button onClick={() => setRole.mutate('member')} disabled={setRole.isPending} className="flex items-center gap-1 bg-warning-50 text-warning font-semibold rounded-lg px-3 py-1.5 text-xs cursor-pointer hover:bg-warning-50/80">Revoke admin</button>
                      : <button onClick={() => { setConfirmCode(''); setGrantConfirm(true) }} disabled={setRole.isPending} className="avg-btn-secondary py-1.5 px-3 text-xs">Grant admin</button>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </Modal>

      {/* Grant-admin confirmation: names the member and requires typing their
          code before the grant is enabled — guards against accidental clicks. */}
      <Modal open={grantConfirm && !!selected} onClose={() => setGrantConfirm(false)} title="Grant admin access" size="sm">
        {selected && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 bg-warning-50 text-warning text-sm p-3 rounded-lg border border-warning/20">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>
                You are about to grant <strong>full admin privileges</strong> to{' '}
                <strong className="text-ink">{selected.name}</strong> ({selected.memberCode}).
                Admins can manage members, orders and payouts.
              </span>
            </div>
            <FormField
              label={`Type ${selected.memberCode} to confirm`}
              value={confirmCode}
              onChange={(e) => setConfirmCode(e.target.value)}
              placeholder={selected.memberCode}
              autoFocus
            />
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setGrantConfirm(false)} className="avg-btn-secondary py-2 px-4 text-xs">Cancel</button>
              <button
                onClick={() => setRole.mutate('admin')}
                disabled={setRole.isPending || confirmCode.trim().toUpperCase() !== selected.memberCode.toUpperCase()}
                className="avg-btn-primary py-2 px-4 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {setRole.isPending ? <Loader2 size={12} className="animate-spin inline mr-1" /> : null}
                Grant admin
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
