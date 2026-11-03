import type { ReactNode } from 'react'

export function Panel({ title, hint, right, className = '', children }: {
  title: string
  hint?: string
  right?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`flex min-h-0 min-w-0 flex-col bg-panel ${className}`}>
      <header className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <h2 className="eyebrow">{title}</h2>
        {hint && <span className="data text-[11px] text-fg-3">{hint}</span>}
        {right && <div className="ml-auto">{right}</div>}
      </header>
      <div className="relative min-h-0 flex-1">{children}</div>
    </section>
  )
}
