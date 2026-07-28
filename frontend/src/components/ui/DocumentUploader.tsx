import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FileText, Loader2, X } from 'lucide-react'
import type { PresignRes } from '../../types/api'
import { uploadToS3 } from '../../lib/s3upload'

export interface UploadedDocument {
  key: string
  name: string
}

interface Props {
  label?: string
  hint?: string
  maxFiles?: number
  value: UploadedDocument[]
  onChange: (docs: UploadedDocument[]) => void
  getPresign: (file: File) => Promise<PresignRes>
}

const ACCEPT = 'application/pdf'
const MAX_BYTES = 50 * 1024 * 1024

/**
 * Multi-PDF picker for product attachments. Presigns via the caller, uploads
 * straight to S3, and lists each file by its original name with a remove button.
 * Uploads immediately on selection (same model as ImageUploader's default);
 * `value` holds `{ key, name }` for the caller to submit as `documents`.
 */
export function DocumentUploader({
  label,
  hint,
  maxFiles = 10,
  value,
  onChange,
  getPresign,
}: Props) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<string[]>([])
  const [error, setError] = useState('')

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    setError('')
    let current = value

    for (const file of Array.from(files)) {
      if (current.length >= maxFiles) break
      if (file.type !== ACCEPT) {
        setError(t('uploader.badPdfType'))
        continue
      }
      if (file.size > MAX_BYTES) {
        setError(t('uploader.tooLargePdf'))
        continue
      }
      try {
        setUploading((u) => [...u, file.name])
        const presignRes = await getPresign(file)
        await uploadToS3(presignRes, file)
        current = [...current, { key: presignRes.key, name: file.name }]
        onChange(current)
      } catch (err) {
        setError(err instanceof Error ? err.message : t('errors.generic'))
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name))
      }
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="space-y-1.5">
      {label && <label className="block text-sm font-medium text-ink">{label}</label>}
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}

      <div className="space-y-2">
        {value.map((doc) => (
          <div
            key={doc.key}
            className="flex items-center gap-2 rounded-lg border border-surface-line bg-[#10141F] px-3 py-2"
          >
            <FileText size={15} className="shrink-0 text-primary" />
            <span className="flex-1 truncate text-sm text-ink">{doc.name}</span>
            <button
              type="button"
              aria-label={t('uploader.remove')}
              onClick={() => onChange(value.filter((v) => v.key !== doc.key))}
              className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-ink-muted hover:bg-danger hover:text-white transition-colors"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {uploading.map((name) => (
          <div
            key={name}
            className="flex items-center gap-2 rounded-lg border border-surface-line bg-[#10141F] px-3 py-2 text-ink-muted"
          >
            <Loader2 size={15} className="shrink-0 animate-spin" />
            <span className="flex-1 truncate text-sm">{name}</span>
            <span className="text-xs">{t('uploader.uploading')}</span>
          </div>
        ))}
      </div>

      {value.length < maxFiles && (
        <button
          type="button"
          disabled={uploading.length > 0}
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-1.5 rounded-lg border border-dashed border-surface-line hover:border-primary px-3 py-2 text-sm text-ink-muted hover:text-primary transition-colors disabled:opacity-50"
        >
          <FilePlus size={16} />
          {t('uploader.addPdf')}
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple={maxFiles > 1}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      {error && <p className="text-xs text-danger font-medium">{error}</p>}
    </div>
  )
}
