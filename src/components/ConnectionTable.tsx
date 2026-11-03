import { useMemo, useState } from 'react'
import type { FilterKey } from '../lib/filter'
import { formatBytes, formatDuration, formatEndpoint, formatRate, formatRtt } from '../lib/format'
import { L7_COLOR } from '../lib/meta'
import type { Conn } from '../lib/types'
import { StateBadge } from './StateBadge'

type SortKey = 'start' | 'proc' | 'state' | 'l7' | 'rx' | 'tx' | 'rtt' | 'retrans' | 'total'

const MAX_ROWS = 300

const COMPARE: Record<SortKey, (a: Conn, b: Conn) => number> = {
  // 默认新连接在上。按速率排序虽然也有用，但每秒都会跳行，所以不作默认
  start: (a, b) => b.startedAt - a.startedAt,
  proc: (a, b) => a.procName.localeCompare(b.procName),
  state: (a, b) => a.state.localeCompare(b.state),
  l7: (a, b) => a.l7.localeCompare(b.l7),
  rx: (a, b) => b.rxRate - a.rxRate,
  tx: (a, b) => b.txRate - a.txRate,
  rtt: (a, b) => b.rttMs - a.rttMs,
  retrans: (a, b) => b.retrans - a.retrans,
  total: (a, b) => b.rxBytes + b.txBytes - (a.rxBytes + a.txBytes),
}

function FilterLink({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="rounded-[2px] hover:bg-wash hover:text-accent"
    >
      {children}
    </button>
  )
}

export function ConnectionTable({ conns, now, selectedId, onSelect, onFilter, compact = false }: {
  conns: Conn[]
  now: number
  selectedId: string | null
  onSelect: (id: string) => void
  onFilter: (key: FilterKey, value: string) => void
  compact?: boolean
}) {
  const [sort, setSort] = useState<SortKey>('start')
  const rows = useMemo(() => [...conns].sort(COMPARE[sort]).slice(0, MAX_ROWS), [conns, sort])

  const th = (label: string, key?: SortKey, right = false, width?: number) => (
    <th scope="col" style={compact && width ? { width } : undefined} aria-sort={key && sort === key ? 'descending' : undefined} className={`sticky top-0 z-[1] whitespace-nowrap border-b border-line-strong bg-panel px-2 py-1 font-medium ${right ? 'text-right' : 'text-left'}`}>
      {key ? (
        <button onClick={() => setSort(key)} className={`eyebrow transition-colors hover:text-fg ${sort === key ? '!text-accent' : ''}`}>
          {label}{sort === key ? ' ↓' : ''}
        </button>
      ) : (
        <span className="eyebrow">{label}</span>
      )}
    </th>
  )

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-fg-3">
        没有符合过滤条件的连接。可以放宽条件，或者勾选“含已关闭”。
      </div>
    )
  }

  return (
    <div className="thin-scroll absolute inset-0 overflow-auto">
      {/* 总览里定宽：真实进程名和域名很长，不能把速率列挤出可视区 */}
      <table className={`w-full border-collapse text-[12px] ${compact ? 'min-w-[780px] table-fixed' : 'min-w-[1040px]'}`}>
        <thead>
          <tr>
            {th('状态', 'state', false, 108)}
            {th('进程', 'proc', false, 138)}
            {th('协议', 'l7', false, 80)}
            {!compact && th('本地地址')}
            {th('远端')}
            {th('↓ 下载', 'rx', true, 78)}
            {th('↑ 上传', 'tx', true, 78)}
            {!compact && th('累计', 'total', true)}
            {th('RTT', 'rtt', true, 54)}
            {!compact && th('重传', 'retrans', true)}
            {th('时长', 'start', true, 62)}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const fresh = now - c.startedAt < 2500
            const closed = c.state === 'CLOSED'
            return (
              <tr
                key={c.id}
                tabIndex={0}
                aria-selected={selectedId === c.id}
                onClick={() => onSelect(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSelect(c.id)
                }}
                className={`cursor-pointer border-b border-line transition-colors hover:bg-raise ${selectedId === c.id ? 'bg-wash' : ''} ${fresh ? 'row-new' : ''} ${closed ? 'opacity-60' : ''}`}
              >
                <td className="whitespace-nowrap px-2 py-[3px]"><StateBadge state={c.state} failure={c.failure} /></td>
                <td className="overflow-hidden whitespace-nowrap px-2 py-[3px]" title={`${c.procName}（PID ${c.pid}）`}>
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 truncate">
                      <FilterLink title={`只看 ${c.procName}`} onClick={() => onFilter('proc', c.procName)}>
                        <span className="font-semibold text-fg">{c.procName}</span>
                      </FilterLink>
                    </span>
                    <span className="data shrink-0 text-[11px] text-fg-3">{c.pid}</span>
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-[3px]">
                  <span className="inline-flex items-center gap-1.5">
                    <i className="h-1.5 w-1.5 rounded-full" style={{ background: L7_COLOR[c.l7] }} />
                    <span className="text-fg">{c.l7}</span>
                    <span className="data text-[10px] text-fg-3">{c.l4}</span>
                  </span>
                </td>
                {!compact && (
                  <td className="data whitespace-nowrap px-2 py-[3px] text-[11px] text-fg-2">{formatEndpoint(c.localIp, c.localPort)}</td>
                )}
                <td className="overflow-hidden px-2 py-[3px]" title={c.host !== c.remoteIp ? `${c.host}（${c.remoteIp}）` : undefined}>
                  <span className="flex items-baseline gap-2 whitespace-nowrap">
                    {c.host !== c.remoteIp && <span className="min-w-0 truncate text-fg">{c.host}</span>}
                    {c.direction === 'listen' ? (
                      <span className="data text-[11px] text-fg-2">
                        :<FilterLink title={`只看端口 ${c.localPort}`} onClick={() => onFilter('port', String(c.localPort))}>{c.localPort}</FilterLink>
                      </span>
                    ) : (
                      <span className="data shrink-0 text-[11px] text-fg-3">
                        {/* 总览里地方不够：已经有域名时只留端口，IP 在悬浮提示和详情里 */}
                        {(!compact || c.host === c.remoteIp) && (
                          <FilterLink title={`只看 IP ${c.remoteIp}`} onClick={() => onFilter('ip', c.remoteIp)}>{c.remoteIp}</FilterLink>
                        )}
                        {(!compact || c.host === c.remoteIp) && ':'}
                        <FilterLink title={`只看端口 ${c.remotePort}`} onClick={() => onFilter('port', String(c.remotePort))}>{c.remotePort}</FilterLink>
                      </span>
                    )}
                  </span>
                </td>
                <td className="data whitespace-nowrap px-2 py-[3px] text-right text-[11px] text-fg-2">{formatRate(c.rxRate)}</td>
                <td className="data whitespace-nowrap px-2 py-[3px] text-right text-[11px] text-fg-2">{formatRate(c.txRate)}</td>
                {!compact && <td className="data whitespace-nowrap px-2 py-[3px] text-right text-[11px] text-fg-2">{formatBytes(c.rxBytes + c.txBytes)}</td>}
                <td className="data whitespace-nowrap px-2 py-[3px] text-right text-[11px] text-fg-2">{formatRtt(c.rttMs)}</td>
                {!compact && <td className="data whitespace-nowrap px-2 py-[3px] text-right text-[11px] text-fg-2">{c.retrans || '—'}</td>}
                <td className="data whitespace-nowrap px-2 py-[3px] text-right text-[11px] text-fg-3">{formatDuration((c.endedAt ?? now) - c.startedAt)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
