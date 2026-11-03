import { hasToken, type FilterKey } from '../lib/filter'
import { STATE_ORDER } from '../lib/meta'
import type { Conn } from '../lib/types'
import { StateBadge } from './StateBadge'

export function StateBreakdown({ conns, query, onFilter }: {
  conns: Conn[]
  query: string
  onFilter: (key: FilterKey, value: string) => void
}) {
  return (
    <section className="bg-panel pb-1.5" aria-label="连接状态分布">
      <header className="flex min-h-9 items-center px-3 py-1.5">
        <h2 className="eyebrow">状态分布</h2>
      </header>
      <div className="grid grid-cols-2 gap-x-2 px-1.5">
        {STATE_ORDER.map((state) => {
          const n = conns.filter((c) => c.state === state).length
          const active = hasToken(query, 'state', state)
          return (
            <button
              key={state}
              aria-pressed={active}
              onClick={() => onFilter('state', state)}
              className={`flex items-center justify-between gap-2 rounded-[3px] px-1.5 py-[2px] transition-colors ${active ? 'bg-wash' : 'hover:bg-raise'} ${n === 0 ? 'opacity-55' : ''}`}
            >
              <StateBadge state={state} />
              <span className="data text-[12px] text-fg">{n}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
