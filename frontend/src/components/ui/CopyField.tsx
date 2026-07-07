import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

interface Props {
  value: string
  label?: string
}

export function CopyField({ value, label }: Props) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  return (
    <div className="space-y-1.5">
      {label && <p className="text-xs font-medium text-ink-muted">{label}</p>}
      <div className="flex items-center gap-2 bg-primary-50 rounded-lg px-3 py-2.5 border border-primary/20 min-w-0">
        <span className="flex-1 text-xs text-ink font-mono truncate">{value}</span>
        <button
          onClick={handleCopy}
          className="flex-shrink-0 p-1 rounded-md hover:bg-primary/10 text-primary transition-colors cursor-pointer"
          aria-label="Copy to clipboard"
        >
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        </button>
      </div>
      {copied && <p className="text-xs text-success font-medium">Copied!</p>}
    </div>
  )
}
