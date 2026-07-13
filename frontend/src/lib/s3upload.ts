import type { PresignRes } from '../types/api'

/**
 * Direct browser → S3 upload with a presigned POST.
 *
 * Deliberately NOT the lib/api.ts axios instance: its interceptors would
 * attach our JWT to a third-party request. XHR (not fetch) because only XHR
 * exposes upload progress events.
 */
export function uploadToS3(
  presign: PresignRes,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    for (const [k, v] of Object.entries(presign.fields)) form.append(k, v)
    form.append('file', file) // must be the last field in a presigned POST

    const xhr = new XMLHttpRequest()
    xhr.open('POST', presign.url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress)
        onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Upload failed (network)'))
    xhr.send(form)
  })
}
