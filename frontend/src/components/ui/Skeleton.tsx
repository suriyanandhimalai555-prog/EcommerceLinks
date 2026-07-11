interface Props {
  className?: string
  lines?: number
}

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-gradient-to-r from-[#1B2236] via-[#232A40] to-[#1B2236] animate-shimmer bg-[length:200%_100%] rounded-lg ${className}`} />
  )
}

export function SkeletonCard({ lines = 3 }: Props) {
  return (
    <div className="avg-card p-5 space-y-3">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  )
}
