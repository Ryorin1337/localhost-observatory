import { useMemo } from 'react'
import { formatClock } from '../lib/format'
import { FAILURE_CODE, STATE_META, stateLabel as short, TONE_VAR } from '../lib/meta'
import type { Conn, StateEvent } from '../lib/types'

const MAX_ROWS = 60

export function EventFeed({ events, visibleIds, onSelect }: {
  events: StateEvent[]
  visibleIds: Conn[]
  onSelect: (id: string) => void
}) {
  const rows = useMemo(() => {
    const ids = new Set(visibleIds.map((c) => c.id))
    return events.filter((e) => ids.has(e.connId)).slice(0, MAX_ROWS)
  }, [events, visibleIds])

  return (
    <section className="flex h-[280px] min-h-0 flex-col bg-panel xl:h-auto xl:flex-1" aria-label="状态变化">
      <header className="flex min-h-9 items-center gap-3 px-3 py-1.5">
        <h2 className="eyebrow">状态变化</h2>
        <span className="data text-[11px] text-fg-3">最新在上</span>
      </header>
      <ol className="thin-scroll min-h-0 flex-1 overflow-y-auto" aria-live="off">
        {rows.map((e, i) => {
          const tone = e.failure ? 'var(--critical)' : TONE_VAR[STATE_META[e.to].tone]
          return (
            <li key={`${e.connId}-${e.t}-${e.to}-${i}`}>
              <button
                onClick={() => onSelect(e.connId)}
                className="block w-full border-t border-line px-3 py-1 text-left transition-colors hover:bg-raise"
              >
                <span className="flex items-baseline gap-2 text-[12px]">
                  <span className="font-semibold text-fg">{e.procName}</span>
                  <span className="truncate text-fg-2">{e.host}</span>
                  <span className="data ml-auto text-[10px] text-fg-3">{formatClock(e.t)}</span>
                </span>
                <span className="data flex items-center gap-1 text-[10.5px] text-fg-2">
                  {e.from && <>{short(e.from)} <span aria-hidden="true">→</span></>}
                  <span style={{ color: tone }} aria-hidden="true">{e.failure ? '✕' : STATE_META[e.to].glyph}</span>
                  <span className="text-fg">{e.failure ? FAILURE_CODE[e.failure] : short(e.to)}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
