import { type ReactNode } from 'react'

type Variant = 'success' | 'warning' | 'danger' | 'neutral' | 'primary' | 'violet'

interface Props {
  variant?: Variant
  children: ReactNode
  size?: 'sm' | 'md'
}

const variantMap: Record<Variant, string> = {
  success: 'avg-badge-success',
  warning: 'avg-badge-warning',
  danger: 'avg-badge-danger',
  neutral: 'avg-badge-neutral',
  primary: 'avg-badge-primary',
  violet: 'inline-flex items-center gap-1 text-xs font-semibold bg-violet-50 text-violet rounded-full px-2.5 py-0.5',
}

export function Badge({ variant = 'neutral', children, size = 'md' }: Props) {
  return (
    <span className={`${variantMap[variant]} ${size === 'sm' ? 'text-[10px] px-2 py-0' : ''}`}>
      {children}
    </span>
  )
}
