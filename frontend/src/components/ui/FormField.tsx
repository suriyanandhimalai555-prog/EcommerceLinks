import { type ReactNode, forwardRef, type InputHTMLAttributes } from 'react'

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  error?: string
  hint?: string
  rightElement?: ReactNode
}

export const FormField = forwardRef<HTMLInputElement, Props>(
  ({ label, error, hint, rightElement, className = '', ...props }, ref) => {
    return (
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-ink" htmlFor={props.id || props.name}>
          {label}
          {props.required && <span className="text-danger ml-0.5">*</span>}
        </label>
        <div className="relative">
          <input
            ref={ref}
            id={props.id || props.name}
            className={`w-full rounded-lg border px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 outline-none transition-all duration-150 focus:ring-2 focus:ring-primary/30 focus:border-primary ${
              error ? 'border-danger bg-danger/10 focus:ring-danger/20 focus:border-danger' : 'border-surface-line bg-[#10141F] hover:border-[#39415E]'
            } ${rightElement ? 'pr-10' : ''} ${className}`}
            {...props}
          />
          {rightElement && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">{rightElement}</div>
          )}
        </div>
        {hint && !error && <p className="text-xs text-ink-muted">{hint}</p>}
        {error && <p className="text-xs text-danger font-medium">{error}</p>}
      </div>
    )
  }
)
FormField.displayName = 'FormField'
