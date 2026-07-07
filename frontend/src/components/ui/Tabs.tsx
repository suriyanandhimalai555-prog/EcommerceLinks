import { type ReactNode, createContext, useContext, useState } from 'react'

interface TabsCtx { active: string; setActive: (v: string) => void }
const Ctx = createContext<TabsCtx>({ active: '', setActive: () => {} })

interface TabsProps { defaultValue: string; children: ReactNode; className?: string }
interface TabListProps { children: ReactNode; className?: string }
interface TabTriggerProps { value: string; children: ReactNode }
interface TabContentProps { value: string; children: ReactNode }

export function Tabs({ defaultValue, children, className = '' }: TabsProps) {
  const [active, setActive] = useState(defaultValue)
  return <Ctx.Provider value={{ active, setActive }}><div className={className}>{children}</div></Ctx.Provider>
}

export function TabList({ children, className = '' }: TabListProps) {
  return (
    <div className={`flex gap-1 bg-gray-100 p-1 rounded-lg overflow-x-auto scrollbar-hide ${className}`}>
      {children}
    </div>
  )
}

export function TabTrigger({ value, children }: TabTriggerProps) {
  const { active, setActive } = useContext(Ctx)
  const isActive = active === value
  return (
    <button
      onClick={() => setActive(value)}
      className={`flex-1 min-w-fit px-3 sm:px-4 py-2 text-sm font-medium rounded-md transition-all duration-200 cursor-pointer whitespace-nowrap ${
        isActive ? 'bg-white text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

export function TabContent({ value, children }: TabContentProps) {
  const { active } = useContext(Ctx)
  if (active !== value) return null
  return <div className="animate-fade-in">{children}</div>
}
