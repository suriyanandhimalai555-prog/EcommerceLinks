/**
 * Download an array of rows as a UTF-8 CSV file.
 * A BOM is prepended so Excel opens Tamil / non-ASCII text correctly.
 */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null)[][],
) {
  const esc = (v: string | number | null): string => {
    const s = v == null ? '' : String(v)
    // Quote fields that contain a comma, double-quote, or line break
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')
  // '﻿' = UTF-8 BOM — tells Excel the file is UTF-8
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
