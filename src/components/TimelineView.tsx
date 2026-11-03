import { useMemo, useState } from 'react'
import { formatClock, formatDuration } from '../lib/format'
import { hash01, isAttention, STATE_META, TONE_VAR } from '../lib/meta'
import { useColors } from '../lib/theme'
import type { Conn, ConnState } from '../lib/types'
import { EChart, echarts, tooltipStyle } from './EChart'
import { Panel } from './Panel'

const WINDOWS = [
  { label: '1 分钟', ms: 60_000 },
  { label: '3 分钟', ms: 180_000 },
  { label: '5 分钟', ms: 300_000 },
]
const MAX_ROWS = 40

interface Seg {
  row: number
  start: number
  end: number
  state: ConnState
  failed: boolean
  conn: Conn
}

const LEGEND: { label: string; color: string; glyph: string }[] = [
  { label: '握手 SYN', color: TONE_VAR.warning, glyph: '◔' },
  { label: 'ESTABLISHED', color: TONE_VAR.good, glyph: '●' },
  { label: 'CLOSE_WAIT', color: TONE_VAR.serious, glyph: '▲' },
  { label: '关闭中 FIN / LAST_ACK', color: TONE_VAR.neutral, glyph: '◑' },
  { label: 'TIME_WAIT', color: TONE_VAR.quiet, glyph: '◌' },
  { label: 'UDP 流', color: TONE_VAR.accent, glyph: '◆' },
  { label: '建连失败', color: TONE_VAR.critical, glyph: '✕' },
]

export function TimelineView({ conns, now, onSelect }: { conns: Conn[]; now: number; onSelect: (id: string) => void }) {
  const c = useColors()
  const [windowMs, setWindowMs] = useState(180_000)
  const narrow = window.innerWidth < 640

  const { option, segs, total, shown } = useMemo(() => {
    const from = now - windowMs
    const inWindow = conns.filter((x) => x.direction !== 'listen' && (x.endedAt ?? now) >= from)
    // 只取最近的 N 条会全挤在右侧几十秒里。这里按稳定哈希抽样，让行铺满整个窗口，
    // 且每秒刷新时不会换一批；有问题的连接优先保留。再按开始时间排成瀑布
    const rank = (x: Conn) => (isAttention(x) ? -1 : 0) + hash01(x.id)
    const rows = [...inWindow]
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, MAX_ROWS)
      .sort((a, b) => a.startedAt - b.startedAt)

    const segs: Seg[] = []
    rows.forEach((conn, row) => {
      conn.transitions.forEach((tr, i) => {
        if (tr.state === 'CLOSED') return
        const end = conn.transitions[i + 1]?.t ?? conn.endedAt ?? now
        if (end < from) return
        segs.push({ row, start: Math.max(tr.t, from), end, state: tr.state, failed: !!conn.failure, conn })
      })
    })

    const colorOf = (s: Seg) => c(s.failed ? '--critical' : TONE_VAR[STATE_META[s.state].tone])

    const option = {
      animation: false,
      grid: { left: narrow ? 118 : 262, right: 16, top: 26, bottom: 10 },
      xAxis: {
        type: 'time',
        position: 'top',
        min: from,
        max: now,
        axisLine: { lineStyle: { color: c('--line-strong') } },
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: c('--line') } },
        axisLabel: { color: c('--fg-3'), fontSize: 10, fontFamily: c('--font-data'), hideOverlap: true, formatter: (v: number) => formatClock(v) },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: rows.map((r) => (narrow ? r.host : `${r.procName} → ${r.host}`)),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: c('--fg-2'),
          fontSize: 11,
          interval: 0,
          fontFamily: c('--font-data'),
          width: narrow ? 108 : 250,
          overflow: 'truncate',
        },
      },
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(c),
        formatter: (p: { dataIndex: number }) => {
          const s = segs[p.dataIndex]
          if (!s) return ''
          const label = s.failed ? `${s.state}（失败）` : s.state === 'UDP_ACTIVE' ? 'UDP 流' : s.state
          return `<b>${s.conn.procName}</b> → ${s.conn.host}<br/>${label} · ${formatDuration(s.end - s.start)}<br/><span style="color:${c('--fg-3')}">${formatClock(s.start)} 开始</span>`
        },
      },
      series: [
        {
          id: 'lifecycle',
          type: 'custom',
          encode: { x: [1, 2], y: 0 },
          data: segs.map((s) => [s.row, s.start, s.end]),
          renderItem: (params: { dataIndex: number; coordSys: { x: number; y: number; width: number; height: number } }, api: {
            value: (i: number) => number
            coord: (v: number[]) => number[]
            size: (v: number[]) => number[]
          }) => {
            const s = segs[params.dataIndex]
            if (!s) return null
            const [x0, y] = api.coord([api.value(1), api.value(0)])
            const [x1] = api.coord([api.value(2), api.value(0)])
            const rowH = api.size([0, 1])[1]
            const h = Math.max(3, Math.min(8, rowH * 0.5))
            // 段与段之间留 1px 缝，极短的状态也至少可见
            const shape = echarts.graphic.clipRectByRect(
              { x: x0, y: y - h / 2, width: Math.max(2, x1 - x0 - 1), height: h },
              params.coordSys,
            )
            if (!shape) return null
            return { type: 'rect', shape: { ...shape, r: 1.5 }, style: { fill: colorOf(s) } }
          },
        },
      ],
    }
    return { option, segs, total: inWindow.length, shown: rows.length }
  }, [conns, now, windowMs, c, narrow])

  return (
    <Panel
      title="连接生命周期"
      hint={total > shown ? `抽样 ${shown} / ${total} 条，异常优先，加过滤条件可看全部` : `${shown} 条`}
      className="h-full"
      right={
        <div className="flex gap-1" role="group" aria-label="时间窗口">
          {WINDOWS.map((w) => (
            <button
              key={w.ms}
              aria-pressed={windowMs === w.ms}
              onClick={() => setWindowMs(w.ms)}
              className={`rounded-[3px] px-2 py-0.5 text-[12px] transition-colors ${windowMs === w.ms ? 'bg-wash text-accent' : 'text-fg-2 hover:bg-raise'}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 pb-1 text-[11px] text-fg-2">
          {LEGEND.map((l) => (
            <span key={l.label} className="data flex items-center gap-1.5">
              <span aria-hidden="true" style={{ color: l.color }}>{l.glyph}</span>
              {l.label}
            </span>
          ))}
        </div>
        <div className="relative min-h-0 flex-1">
          <EChart
            option={option}
            label="每条连接在各个 TCP 状态停留时长的时间线，同样的数据可在连接详情中查看"
            onItemClick={(p) => {
              const s = segs[p.dataIndex]
              if (s) onSelect(s.conn.id)
            }}
          />
        </div>
      </div>
    </Panel>
  )
}
