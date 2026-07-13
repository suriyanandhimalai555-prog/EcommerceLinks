import { useState } from 'react'
import { ImageOff } from 'lucide-react'

interface Props {
  images: { url: string }[]
  alt: string
}

/** Main image with a thumbnail-strip switcher. */
export function ImageGallery({ images, alt }: Props) {
  const [active, setActive] = useState(0)

  if (images.length === 0) {
    return (
      <div className="aspect-video rounded-xl border border-surface-line bg-[#10141F] flex items-center justify-center text-ink-muted">
        <ImageOff size={32} />
      </div>
    )
  }

  const current = images[Math.min(active, images.length - 1)]

  return (
    <div className="space-y-2">
      <div className="aspect-video rounded-xl overflow-hidden border border-surface-line bg-[#10141F]">
        <img src={current.url} alt={alt} className="w-full h-full object-contain" />
      </div>
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.map((img, i) => (
            <button
              key={img.url}
              type="button"
              onClick={() => setActive(i)}
              className={`shrink-0 w-14 h-14 rounded-lg overflow-hidden border transition-colors ${
                i === active ? 'border-primary ring-2 ring-primary/30' : 'border-surface-line hover:border-[#39415E]'
              }`}
            >
              <img src={img.url} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
