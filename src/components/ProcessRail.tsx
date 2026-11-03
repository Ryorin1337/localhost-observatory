import { useMemo } from 'react'
import { hasToken, matches, parseQuery, type FilterKey } from '../lib/filter'
import { formatRate } from '../lib/format'
import { isLive } from '../lib/meta'
import { aggregate, type RatePoint, type Snapshot } from '../lib/store'

const SPARK_SECONDS = 60

function Sparkline({ points }: { points: RatePoint[] }) {
  const w = 232
  const h = 26
  const max = Math.max(1, ...points.map((p) => p.rx + p.tx))
  const y = (v: number) => h - 1.5 - (v / max) * (h - 3)
  const x = (i: number) => (i / (points.length - 1)) * w
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.rx + p.tx).toFixed(1)}`).join('')
  const last = points[points.length - 1]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block h-[26px] w-full" aria-hidden="true">
      <path d={`${line}L${w} ${h}L0 ${h}Z`} fill="var(--down)" opacity="0.14" />
      <path d={line} fill="none" stroke="var(--down)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
      <circle cx={w - 1.5} cy={y(last.rx + last.tx)} r="1.8" fill="var(--down)" />
    </svg>
  )
}

export function ProcessRail({ snap, query, onFilter }: {
  snap: Snapshot
  query: string
  onFilter: (key: FilterKey, value: string) => void
}) {
  const rows = useMemo(() => {
    // 进程列表不受 proc: 条件影响，方便切换；其他条件仍然生效
    const tokens = parseQuery(query).filter((t) => t.key !== 'proc')
    const conns = snap.conns.filter((c) => matches(c, tokens))
    const byPid = new Map<number, typeof conns>()
    for (const c of conns) {
      // PID 0 是所属进程已退出、只剩 TIME_WAIT 的连接，不属于 System Process
      if (c.direction === 'listen' || c.pid === 0) continue
      byPid.set(c.pid, [...(byPid.get(c.pid) ?? []), c])
    }
    // 系统里有几百个进程，这里只列有连接的
    return [...byPid.keys()]
      .map((pid) => snap.procs.find((p) => p.pid === pid) ?? { pid, name: byPid.get(pid)![0].procName, cmd: '' })
      .map((p) => {
        const own = byPid.get(p.pid)!
        const points = aggregate(own, snap, SPARK_SECONDS)
        const liveOwn = own.filter(isLive)
        return {
          ...p,
          points,
          count: liveOwn.length,
          rx: liveOwn.reduce((s, c) => s + c.rxRate, 0),
          tx: liveOwn.reduce((s, c) => s + c.txRate, 0),
          volume: points.reduce((s, q) => s + q.rx + q.tx, 0),
        }
      })
      .sort((a, b) => b.volume - a.volume || b.count - a.count || a.pid - b.pid)
    // snap 每秒更新一次
  }, [snap, query])

  return (
    <section className="flex h-full max-h-[420px] min-h-0 flex-col bg-panel xl:max-h-none" aria-label="进程">
      <header className="flex min-h-9 items-center gap-3 px-3 py-1.5">
        <h2 className="eyebrow">进程</h2>
        <span className="data text-[11px] text-fg-3">按近 60 秒流量排序</span>
      </header>
      <ul className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {rows.map((p) => {
          const active = hasToken(query, 'proc', p.name)
          return (
            <li key={p.pid}>
              <button
                aria-pressed={active}
                title={p.cmd}
                onClick={() => onFilter('proc', p.name)}
                className={`block w-full border-t border-line px-3 py-2 text-left transition-colors ${active ? 'bg-wash' : 'hover:bg-raise'} ${p.count === 0 ? 'opacity-50' : ''}`}
              >
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-semibold text-fg">{p.name}</span>
                  <span className="data text-[11px] text-fg-3">{p.pid}</span>
                  <span className="data ml-auto whitespace-nowrap text-[11px] text-fg-3">{p.count} 连接</span>
                </span>
                <span className="data mt-0.5 grid grid-cols-2 gap-2 text-[11px] text-fg-2">
                  <span className="whitespace-nowrap"><span aria-hidden="true" style={{ color: 'var(--down)' }}>↓</span> {formatRate(p.rx)}</span>
                  <span className="whitespace-nowrap"><span aria-hidden="true" style={{ color: 'var(--up)' }}>↑</span> {formatRate(p.tx)}</span>
                </span>
                <span className="mt-1 block"><Sparkline points={p.points} /></span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
