import { forwardRef } from 'react'
import { hasToken, type FilterKey } from '../lib/filter'
import { isLive, L7_COLOR, MAIN_L7 } from '../lib/meta'
import type { Conn } from '../lib/types'

const L7_GLYPH: Record<string, string> = { TLS: '●', HTTP: '■', DNS: '▲', QUIC: '◆' }

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-[3px] border px-2 py-[3px] text-[12px] transition-colors ${
        active ? 'border-accent bg-wash text-fg' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

export const FilterBar = forwardRef<HTMLInputElement, {
  query: string
  onQuery: (q: string) => void
  onFilter: (key: FilterKey, value: string) => void
  all: Conn[]
  shown: number
  includeClosed: boolean
  onIncludeClosed: (v: boolean) => void
}>(function FilterBar({ query, onQuery, onFilter, all, shown, includeClosed, onIncludeClosed }, ref) {
  const live = all.filter(isLive)
  const count = (fn: (c: Conn) => boolean) => live.filter(fn).length

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="relative min-w-0 flex-1 basis-[320px] xl:max-w-[560px]">
        <label htmlFor="conn-filter" className="sr-only">过滤连接</label>
        <input
          id="conn-filter"
          ref={ref}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="过滤  proc:node  ip:203.0  port:443  state:close_wait"
          className="data w-full rounded-[3px] border border-line-strong bg-panel py-1 pl-2.5 pr-8 text-[12px] text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
        />
        {query ? (
          <button onClick={() => onQuery('')} aria-label="清除过滤" className="absolute right-1 top-1/2 -translate-y-1/2 px-1.5 text-fg-3 hover:text-fg">×</button>
        ) : (
          <kbd className="data absolute right-2 top-1/2 -translate-y-1/2 rounded-[2px] border border-line px-1 text-[10px] text-fg-3">/</kbd>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="按协议过滤">
        {(['TCP', 'UDP'] as const).map((p) => (
          <Chip key={p} active={hasToken(query, 'proto', p)} onClick={() => onFilter('proto', p)}>
            {p} <span className="data text-[11px] text-fg-3">{count((c) => c.l4 === p)}</span>
          </Chip>
        ))}
        <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
        {MAIN_L7.map((p) => (
          <Chip key={p} active={hasToken(query, 'proto', p)} onClick={() => onFilter('proto', p)}>
            <span aria-hidden="true" className="text-[9px]" style={{ color: L7_COLOR[p] }}>{L7_GLYPH[p]}</span>
            {p} <span className="data text-[11px] text-fg-3">{count((c) => c.l7 === p)}</span>
          </Chip>
        ))}
        <Chip active={hasToken(query, 'proto', 'other')} onClick={() => onFilter('proto', 'other')}>
          <span aria-hidden="true" className="text-[9px]" style={{ color: 'var(--p-other)' }}>○</span>
          其他 <span className="data text-[11px] text-fg-3">{count((c) => !MAIN_L7.includes(c.l7))}</span>
        </Chip>
      </div>

      <div className="flex items-center gap-3 xl:ml-auto">
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg-2">
          <input id="include-closed" type="checkbox" checked={includeClosed} onChange={(e) => onIncludeClosed(e.target.checked)} className="accent-[var(--accent)]" />
          含已关闭
        </label>
        <span className="data whitespace-nowrap text-[12px] text-fg-3">{shown} / {live.length} 活动</span>
      </div>
    </div>
  )
})
