import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Package, Pencil, Plus, Trash2, AlertTriangle } from 'lucide-react'
import api from '../../lib/api'
import { formatINR, rupeesToPaise } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { FormField } from '../../components/ui/FormField'
import { ImageUploader, type UploadedImage } from '../../components/ui/ImageUploader'
import { Tabs, TabList, TabTrigger, TabContent } from '../../components/ui/Tabs'
import type { AdminProduct, PresignRes } from '../../types/api'

interface FormState {
  id: number | null
  name: string
  description: string
  priceRupees: string
  active: boolean
  images: UploadedImage[]
}

const emptyForm: FormState = {
  id: null,
  name: '',
  description: '',
  priceRupees: '',
  active: true,
  images: [],
}

function getPresign(file: File): Promise<PresignRes> {
  return api
    .post('/admin/products/images/presign', {
      contentType: file.type,
      sizeBytes: file.size,
    })
    .then((r) => r.data)
}

export function ProductsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  // ── edit form ────────────────────────────────────────────────────────────
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState('')

  // ── delete confirm ───────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<AdminProduct | null>(null)
  // hasOrders: permanent block (409 — button stays hidden); deleteError: any error message shown
  const [hasOrders, setHasOrders] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const { data: products, isPending } = useQuery<AdminProduct[]>({
    queryKey: ['admin-products'],
    queryFn: () => api.get('/admin/products').then((r) => r.data),
  })

  const activeProducts = (products ?? []).filter((p) => p.active)
  const inactiveProducts = (products ?? []).filter((p) => !p.active)

  // ── save (create / update) ───────────────────────────────────────────────
  const save = useMutation({
    mutationFn: (f: FormState) => {
      const payload = {
        name: f.name.trim(),
        description: f.description.trim(),
        basePricePaise: rupeesToPaise(f.priceRupees),
        active: f.active,
        imageKeys: f.images.map((i) => i.key),
      }
      return f.id === null
        ? api.post('/admin/products', payload)
        : api.patch(`/admin/products/${f.id}`, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-products'] })
      qc.invalidateQueries({ queryKey: ['products'] })
      setForm(null)
    },
    onError: () => setFormError(t('errors.server')),
  })

  // ── delete ───────────────────────────────────────────────────────────────
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/products/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-products'] })
      qc.invalidateQueries({ queryKey: ['products'] })
      setDeleteTarget(null)
      setHasOrders(false)
      setDeleteError('')
    },
    onError: (e: unknown) => {
      const err = e as { response?: { status?: number; data?: { error?: string } }; message?: string }
      if (err.response?.status === 409) {
        // Permanent block: product has orders — hide confirm button, show deactivate guidance
        setHasOrders(true)
        setDeleteError(t('admin.products.deleteCannotHasOrders'))
      } else {
        // Transient error: keep button live so the user can retry
        setHasOrders(false)
        const raw = err.response?.data?.error
        setDeleteError(raw ?? t('admin.products.deleteError'))
      }
    },
  })

  function openEdit(p: AdminProduct) {
    setFormError('')
    setForm({
      id: p.id,
      name: p.name,
      description: p.description,
      priceRupees: (p.basePricePaise / 100).toFixed(2),
      active: p.active,
      images: p.images.map((img) => ({ key: img.key, previewUrl: img.url })),
    })
  }

  function openDelete(p: AdminProduct) {
    del.reset()
    setHasOrders(false)
    setDeleteError('')
    setDeleteTarget(p)
  }

  function closeDelete() {
    del.reset()
    setHasOrders(false)
    setDeleteError('')
    setDeleteTarget(null)
  }

  function submit() {
    if (!form) return
    setFormError('')
    if (!form.name.trim()) return setFormError(t('admin.products.nameRequired'))
    const paise = rupeesToPaise(form.priceRupees)
    if (!Number.isFinite(paise) || paise <= 0)
      return setFormError(t('admin.products.priceInvalid'))
    save.mutate(form)
  }

  const columns: Column<AdminProduct>[] = [
    {
      key: 'image', header: '',
      render: (p) =>
        p.images[0] ? (
          <img src={p.images[0].url} alt="" className="w-10 h-10 rounded-lg object-cover border border-surface-line" />
        ) : (
          <div className="w-10 h-10 rounded-lg border border-surface-line bg-[#10141F] flex items-center justify-center text-ink-muted">
            <Package size={16} />
          </div>
        ),
    },
    { key: 'name', header: t('admin.products.name'), render: (p) => <span className="font-medium text-ink">{p.name}</span> },
    { key: 'price', header: t('admin.products.price'), render: (p) => <span className="text-ink">{formatINR(p.basePricePaise)}</span> },
    {
      key: 'images', header: t('admin.products.images'),
      render: (p) => <span className="text-xs text-ink-muted">{p.images.length}</span>,
    },
    {
      key: 'active', header: t('admin.products.active'),
      render: (p) => <Badge variant={p.active ? 'success' : 'neutral'}>{p.active ? 'Active' : 'Hidden'}</Badge>,
    },
    {
      key: 'actions', header: '', align: 'right',
      render: (p) => (
        <div className="flex items-center gap-2 justify-end">
          <button onClick={() => openEdit(p)} className="avg-btn-secondary py-1.5 px-3 text-xs">
            <Pencil size={12} /> {t('admin.products.edit')}
          </button>
          <button
            onClick={() => openDelete(p)}
            className="flex items-center gap-1 py-1.5 px-3 text-xs rounded-lg border border-danger/30 bg-danger/5 text-danger hover:bg-danger/15 transition-colors"
          >
            <Trash2 size={12} /> {t('admin.products.delete')}
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="avg-card">
      <div className="p-5 pb-0 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">{t('admin.products.title')}</h2>
        <button
          onClick={() => { setFormError(''); setForm({ ...emptyForm }) }}
          className="avg-btn-primary py-1.5 px-3 text-xs"
        >
          <Plus size={13} /> {t('admin.products.add')}
        </button>
      </div>

      <div className="px-5 pt-4">
        <Tabs defaultValue="active">
          <TabList>
            <TabTrigger value="active">
              {t('admin.products.tabActive', { count: activeProducts.length })}
            </TabTrigger>
            <TabTrigger value="inactive">
              {t('admin.products.tabInactive', { count: inactiveProducts.length })}
            </TabTrigger>
          </TabList>

          <TabContent value="active">
            <DataTable
              columns={columns}
              data={activeProducts}
              loading={isPending}
              rowKey={(p) => String(p.id)}
              emptyTitle={t('admin.products.emptyTitle')}
              emptyDescription={t('admin.products.emptyDesc')}
            />
          </TabContent>

          <TabContent value="inactive">
            <DataTable
              columns={columns}
              data={inactiveProducts}
              loading={isPending}
              rowKey={(p) => String(p.id)}
              emptyTitle={t('admin.products.emptyTitleInactive')}
              emptyDescription={t('admin.products.emptyDescInactive')}
            />
          </TabContent>
        </Tabs>
      </div>

      {/* ── Edit / Create modal ─────────────────────────────────────────── */}
      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id === null ? t('admin.products.add') : t('admin.products.edit')}
        size="lg"
      >
        {form && (
          <div className="space-y-4">
            <FormField
              label={t('admin.products.name')}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-ink">{t('admin.products.description')}</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={4}
                className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
            </div>
            <FormField
              label={t('admin.products.price')}
              required
              inputMode="decimal"
              placeholder="10000.00"
              value={form.priceRupees}
              onChange={(e) => setForm({ ...form, priceRupees: e.target.value })}
              hint={t('admin.products.priceHint')}
            />
            <ImageUploader
              label={t('admin.products.images')}
              value={form.images}
              onChange={(images) => setForm({ ...form, images })}
              getPresign={getPresign}
            />
            <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="accent-[--color-primary]"
              />
              {t('admin.products.activeHint')}
            </label>
            {formError && <p className="text-xs text-danger font-medium">{formError}</p>}
            <button onClick={submit} disabled={save.isPending} className="avg-btn-primary w-full">
              {save.isPending ? <Loader2 size={15} className="animate-spin" /> : null}
              {t('admin.products.save')}
            </button>
          </div>
        )}
      </Modal>

      {/* ── Delete confirm modal ────────────────────────────────────────── */}
      <Modal
        open={!!deleteTarget}
        onClose={closeDelete}
        title={t('admin.products.deleteConfirmTitle')}
        size="sm"
      >
        {deleteTarget && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              {t('admin.products.deleteConfirmBody', { name: deleteTarget.name })}
            </p>

            {/* Warning: amber = permanent block (has orders); red = transient, retry possible */}
            {deleteError && (
              <div
                className={`flex items-start gap-2.5 rounded-xl p-3 border ${
                  hasOrders
                    ? 'bg-warning/8 border-warning/20'
                    : 'bg-danger/10 border-danger/30'
                }`}
              >
                <AlertTriangle size={13} className={`shrink-0 mt-0.5 ${hasOrders ? 'text-warning' : 'text-danger'}`} />
                <p className={`text-xs ${hasOrders ? 'text-warning/90' : 'text-danger'}`}>{deleteError}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={closeDelete} className="flex-1 avg-btn-secondary py-2">
                {t('common.cancel')}
              </button>
              {/* Hide confirm only when the product genuinely cannot be deleted (409). Transient errors keep the button live. */}
              {!hasOrders && (
                <button
                  onClick={() => del.mutate(deleteTarget.id)}
                  disabled={del.isPending}
                  className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl bg-danger text-white text-sm font-semibold hover:bg-danger/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {del.isPending && <Loader2 size={13} className="animate-spin" />}
                  {t('admin.products.delete')}
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
