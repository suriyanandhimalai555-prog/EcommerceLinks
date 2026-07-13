import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Package, Pencil, Plus } from 'lucide-react'
import api from '../../lib/api'
import { formatINR, rupeesToPaise } from '../../lib/format'
import { DataTable, type Column } from '../../components/ui/DataTable'
import { Badge } from '../../components/ui/Badge'
import { Modal } from '../../components/ui/Modal'
import { FormField } from '../../components/ui/FormField'
import { ImageUploader, type UploadedImage } from '../../components/ui/ImageUploader'
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
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState('')

  const { data: products, isPending } = useQuery<AdminProduct[]>({
    queryKey: ['admin-products'],
    queryFn: () => api.get('/admin/products').then((r) => r.data),
  })

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
        <button onClick={() => openEdit(p)} className="avg-btn-secondary py-1.5 px-3 text-xs">
          <Pencil size={12} /> {t('admin.products.edit')}
        </button>
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
      <DataTable
        columns={columns}
        data={products ?? []}
        loading={isPending}
        rowKey={(p) => String(p.id)}
        emptyTitle={t('admin.products.emptyTitle')}
        emptyDescription={t('admin.products.emptyDesc')}
      />

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
    </div>
  )
}
