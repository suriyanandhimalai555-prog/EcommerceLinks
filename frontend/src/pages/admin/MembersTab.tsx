import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Search, Loader2, ShieldCheck, ShieldOff, KeyRound, Wallet, UserCog } from 'lucide-react'
import api from '../../lib/api'
import { apiErrorMessage } from '../../lib/apiError'
import { isManagement } from '../../lib/roles'
import { formatDate } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { FormField } from '../../components/ui/FormField'
import type { AdminMemberRow, Me } from '../../types/api'

export function MembersTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<AdminMemberRow | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // form state for the action modal
  const [contact, setContact] = useState({ name: '', email: '', phone: '' })
  const [adjust, setAdjust] = useState({ rupees: '', direction: 'credit' as 'credit' | 'debit', notes: '' })
  const [newPassword, setNewPassword] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setQ(input), 350)
    return () => clearTimeout(t)
  }, [input])

  const { data: me } = useQuery<Me>({ queryKey: ['me'], queryFn: () => api.get('/me').then((r) => r.data) })
  const { data: members, isPending } = useQuery<AdminMemberRow[]>({
    queryKey: ['admin-members', q],
    queryFn: () => api.get(`/admin/members?q=${encodeURIComponent(q)}`).then((r) => r.data),
    placeholderData: keepPreviousData,
  })

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
      email: contact.email === '' ? null : contact.email,
      phone: contact.phone,
    }),
    onSuccess: () => refresh('Contact details saved'),
    onError: fail,
  })
  const setKyc = useMutation({
    mutationFn: (status: 'verified' | 'rejected' | 'pending') => api.post(`/admin/members/${selected!.id}/kyc`, { status }),
    onSuccess: (_, status) => refresh(`KYC marked ${status}`),
    onError: fail,
  })
  const setBank = useMutation({
    mutationFn: (status: 'verified' | 'pending') => api.post(`/admin/members/${selected!.id}/bank`, { status }),
    onSuccess: (_, status) => refresh(`Bank marked ${status}`),
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
    onSuccess: (_, role) => { refresh(`Role set to ${role}`); setSelected((s) => (s ? { ...s, role } : s)) },
    onError: fail,
  })

  const columns: Column<AdminMemberRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs font-semibold text-ink">{r.memberCode}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="text-sm font-medium text-ink">{r.name}</span> },
    { key: 'phone', header: 'Phone', render: (r) => <span className="text-xs text-ink-muted">{r.phone}</span> },
    {
      key: 'role', header: 'Role',
      render: (r) => r.role === 'management'
        ? <Badge variant="violet" size="sm">management</Badge>
        : r.role === 'admin' ? <Badge variant="primary" size="sm">admin</Badge> : <span className="text-xs text-ink-muted">member</span>,
    },
    { key: 'kyc', header: 'KYC', render: (r) => <Badge size="sm" variant={r.kycStatus === 'verified' ? 'success' : r.kycStatus === 'rejected' ? 'danger' : 'neutral'}>{r.kycStatus}</Badge> },
    { key: 'bank', header: 'Bank', render: (r) => <Badge size="sm" variant={r.bankStatus === 'verified' ? 'success' : 'neutral'}>{r.bankStatus}</Badge> },
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
        data={members ?? []}
        loading={isPending}
        rowKey={(r) => r.id}
        emptyTitle="No members found"
        emptyDescription="Try a different search"
      />

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? `${selected.name} — ${selected.memberCode}` : ''} size="lg">
        {selected && (
          <div className="space-y-5 max-h-[65vh] overflow-y-auto pr-1">
            {msg && (
              <div className={`text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
                {msg.text}
              </div>
            )}

            {/* Contact */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Contact details</h3>
              <FormField label="Name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
                <FormField label="Phone" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
              </div>
              <button onClick={() => saveContact.mutate()} disabled={saveContact.isPending} className="avg-btn-secondary py-2 text-xs">
                {saveContact.isPending ? <Loader2 size={12} className="animate-spin" /> : null} Save contact
              </button>
            </section>

            {/* Verification */}
            <section className="space-y-2 border-t border-surface-line pt-4">
              <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Verification</h3>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-muted w-14">KYC</span>
                <button onClick={() => setKyc.mutate('verified')} className="avg-btn-secondary py-1.5 px-3 text-xs"><ShieldCheck size={12} /> Verify</button>
                <button onClick={() => setKyc.mutate('rejected')} className="avg-btn-danger">Reject</button>
                <button onClick={() => setKyc.mutate('pending')} className="flex items-center gap-1 bg-white/5 text-ink-muted font-semibold rounded-lg px-3 py-1.5 text-xs cursor-pointer hover:bg-white/10">Reset to pending</button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-muted w-14">Bank</span>
                <button onClick={() => setBank.mutate('verified')} className="avg-btn-secondary py-1.5 px-3 text-xs"><ShieldCheck size={12} /> Verify</button>
                <button onClick={() => setBank.mutate('pending')} className="flex items-center gap-1 bg-white/5 text-ink-muted font-semibold rounded-lg px-3 py-1.5 text-xs cursor-pointer hover:bg-white/10">Reset to pending</button>
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
                      : <button onClick={() => setRole.mutate('admin')} disabled={setRole.isPending} className="avg-btn-secondary py-1.5 px-3 text-xs">Grant admin</button>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </Modal>
    </div>
  )
}
