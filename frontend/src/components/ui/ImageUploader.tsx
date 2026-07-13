import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImagePlus, X } from 'lucide-react'
import type { PresignRes } from '../../types/api'
import { uploadToS3 } from '../../lib/s3upload'

export interface UploadedImage {
  key: string
  previewUrl: string
}

interface Props {
  label?: string
  maxFiles?: number
  value: UploadedImage[]
  onChange: (images: UploadedImage[]) => void
  getPresign: (file: File) => Promise<PresignRes>
}

const ACCEPT = 'image/jpeg,image/png,image/webp'
const MAX_BYTES = 5 * 1024 * 1024

/**
 * Multi-image picker: presigns via the caller, uploads straight to S3 with a
 * progress bar, previews via object URLs, lets the user remove entries.
 * `value` order is the display/sort order the caller submits.
 */
export function ImageUploader({ label, maxFiles = 8, value, onChange, getPresign }: Props) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [error, setError] = useState('')

  // Object URLs leak unless revoked when the uploader unmounts.
  const urlsRef = useRef<string[]>([])
  useEffect(() => {
    return () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url)
    }
  }, [])

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    setError('')
    let current = value
    for (const file of Array.from(files)) {
      if (current.length >= maxFiles) break
      if (!ACCEPT.split(',').includes(file.type)) {
        setError(t('uploader.badType'))
        continue
      }
      if (file.size > MAX_BYTES) {
        setError(t('uploader.tooLarge'))
        continue
      }
      try {
        const presign = await getPresign(file)
        setProgress((p) => ({ ...p, [presign.key]: 0 }))
        await uploadToS3(presign, file, (pct) =>
          setProgress((p) => ({ ...p, [presign.key]: pct })),
        )
        const previewUrl = URL.createObjectURL(file)
        urlsRef.current.push(previewUrl)
        current = [...current, { key: presign.key, previewUrl }]
        onChange(current)
        setProgress((p) => {
          const { [presign.key]: _done, ...rest } = p
          return rest
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : t('errors.generic'))
      }
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  const uploading = Object.keys(progress).length > 0

  return (
    <div className="space-y-1.5">
      {label && <label className="block text-sm font-medium text-ink">{label}</label>}
      <div className="flex flex-wrap gap-3">
        {value.map((img) => (
          <div
            key={img.key}
            className="relative w-20 h-20 rounded-lg overflow-hidden border border-surface-line bg-[#10141F]"
          >
            <img src={img.previewUrl} alt="" className="w-full h-full object-cover" />
            <button
              type="button"
              aria-label={t('uploader.remove')}
              onClick={() => onChange(value.filter((v) => v.key !== img.key))}
              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 flex items-center justify-center text-white hover:bg-danger transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {Object.entries(progress).map(([key, pct]) => (
          <div
            key={key}
            className="w-20 h-20 rounded-lg border border-surface-line bg-[#10141F] flex flex-col items-center justify-center gap-1.5 px-2"
          >
            <span className="text-[10px] text-ink-muted">{t('uploader.uploading')}</span>
            <div className="w-full h-1 rounded bg-surface-line overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ))}
        {value.length < maxFiles && (
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="w-20 h-20 rounded-lg border border-dashed border-surface-line hover:border-primary flex flex-col items-center justify-center gap-1 text-ink-muted hover:text-primary transition-colors disabled:opacity-50"
          >
            <ImagePlus size={20} />
            <span className="text-[10px]">{t('uploader.add')}</span>
          </button>
        )}
      </div>
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
