import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslation } from 'react-i18next'
import { Loader2, CheckCircle2, X } from 'lucide-react'
import { FormField } from '../../components/ui/FormField'
import { ImageUploader, type UploadedImage } from '../../components/ui/ImageUploader'
import api from '../../lib/api'
import type { KycDocument, Me, PresignRes } from '../../types/api'

const kycSchema = z.object({
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN format (e.g. ABCDE1234F)'),
  aadhaarLast4: z
    .string()
    .length(4, 'Enter last 4 digits of Aadhaar')
    .regex(/^\d{4}$/, 'Digits only'),
})

export function KycTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const { data: me } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/me').then((r) => r.data),
  })

  const { data: kycDocs } = useQuery<KycDocument[]>({
    queryKey: ['kycDocuments'],
    queryFn: () => api.get('/me/kyc/documents').then((r) => r.data),
  })

  const [kycSuccess, setKycSuccess] = useState(false)
  const [docType, setDocType] = useState<KycDocument['docType']>('pan')
  const [pendingDocs, setPendingDocs] = useState<UploadedImage[]>([])

  // Reactive prefill: RHF `values` re-fills the form whenever `me` loads/changes.
  const kycForm = useForm({
    resolver: zodResolver(kycSchema),
    values: {
      pan: me?.pan ?? '',
      aadhaarLast4: me?.aadhaarLast4 ?? '',
    },
  })

  const kycMutation = useMutation({
    mutationFn: (d: z.infer<typeof kycSchema>) => api.put('/me/kyc', d),
    onSuccess: () => {
      setKycSuccess(true)
      qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  const registerDoc = useMutation({
    mutationFn: (img: UploadedImage) =>
      api.post('/me/kyc/documents', { key: img.key, docType }),
    onSuccess: () => {
      setPendingDocs([])
      qc.invalidateQueries({ queryKey: ['kycDocuments'] })
      qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  const deleteDoc = useMutation({
    mutationFn: (id: string) => api.delete(`/me/kyc/documents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kycDocuments'] })
      qc.invalidateQueries({ queryKey: ['me'] })
    },
  })

  function handleDeleteDoc(id: string, docType: string) {
    if (!window.confirm(`Remove this ${docType.toUpperCase()} document? The file will remain in storage but the reference will be deleted.`)) return
    deleteDoc.mutate(id)
  }

  function getKycPresign(file: File): Promise<PresignRes> {
    return api
      .post('/me/kyc/presign', {
        docType,
        contentType: file.type,
        sizeBytes: file.size,
      })
      .then((r) => r.data)
  }

  return (
    <div className="avg-card p-5">
      {/* PAN + Aadhaar form */}
      {kycSuccess ? (
        <div className="flex items-center gap-2 text-success">
          <CheckCircle2 size={16} /> KYC submitted. Pending admin review.
        </div>
      ) : (
        <form
          onSubmit={kycForm.handleSubmit((d) => kycMutation.mutate(d))}
          className="space-y-4"
        >
          <FormField
            label="PAN Number"
            placeholder="ABCDE1234F"
            {...kycForm.register('pan')}
            error={kycForm.formState.errors.pan?.message}
          />
          <FormField
            label="Aadhaar Last 4 Digits"
            type="number"
            maxLength={4}
            placeholder="XXXX"
            {...kycForm.register('aadhaarLast4')}
            error={kycForm.formState.errors.aadhaarLast4?.message}
          />
          <button type="submit" disabled={kycMutation.isPending} className="avg-btn-primary">
            {kycMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
            Submit KYC
          </button>
        </form>
      )}

      {/* Document upload */}
      <div className="mt-6 pt-5 border-t border-surface-line space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">{t('profile.kycUploadTitle')}</h3>
          <p className="text-xs text-ink-muted">{t('profile.kycUploadHint')}</p>
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-ink">{t('profile.kycDocType')}</label>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value as KycDocument['docType'])}
            className="w-full rounded-lg border border-surface-line bg-[#10141F] px-3 py-2.5 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          >
            <option value="pan">PAN</option>
            <option value="aadhaar">Aadhaar</option>
            <option value="other">{t('profile.kycDocOther')}</option>
          </select>
        </div>
        <ImageUploader
          maxFiles={1}
          value={pendingDocs}
          onChange={(imgs) => {
            setPendingDocs(imgs)
            const added = imgs[imgs.length - 1]
            if (added) registerDoc.mutate(added)
          }}
          getPresign={getKycPresign}
        />

        {/* Persisted documents */}
        {kycDocs && kycDocs.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">
              {t('profile.kycDocuments')}
            </h4>
            <div className="flex flex-wrap gap-3">
              {kycDocs.map((d) => (
                <div key={d.id} className="relative group">
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block w-20 text-center"
                  >
                    <img
                      src={d.url}
                      alt={d.docType}
                      className="w-20 h-20 rounded-lg object-cover border border-surface-line group-hover:border-primary transition-colors"
                    />
                    <span className="text-[10px] text-ink-muted uppercase">{d.docType}</span>
                  </a>
                  {/* Delete button — removes DB reference only, no S3 delete */}
                  <button
                    type="button"
                    onClick={() => handleDeleteDoc(d.id, d.docType)}
                    disabled={deleteDoc.isPending}
                    aria-label={`Remove ${d.docType} document`}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-700 disabled:opacity-50"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
