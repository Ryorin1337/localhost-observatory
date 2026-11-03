import { useMemo } from 'react'
import { formatRate, formatRtt } from '../lib/format'
import { hash01, L7_COLOR, L7_SYMBOL, MAIN_L7 } from '../lib/meta'
import { useColors } from '../lib/theme'
import type { Conn } from '../lib/types'
import { EChart, tooltipStyle } from './EChart'
import { Panel } from './Panel'

const GROUPS = [...MAIN_L7, '其他'] as const

/** 扇区太多时只标注流量最大的几个，其余靠悬浮提示 */
const MAX_LABELS = 10

/** RTT 按对数映射到半径：0.1ms 落在 1，1s 落在 5。回环没有 RTT 样本，放最内圈；其他未知的放最外圈 */
function toRadius(conn: Conn) {
  if (conn.rttMs > 0) return Math.min(Math.log10(Math.max(conn.rttMs, 0.05)) + 2, 4.6)
  return conn.remoteIp === '127.0.0.1' || conn.remoteIp === '::1' ? 1 : 4.8
}

const RING_LABEL: Record<number, string> = { 1: '0.1ms', 2: '1ms', 3: '10ms', 4: '100ms', 5: '未知' }
const LEGEND_GLYPH: Record<string, string> = { TLS: '●', HTTP: '■', DNS: '▲', QUIC: '◆', 其他: '○' }

/** 连接星图：本机在圆心，每颗星是一条连接。方位 = 进程，距离 = RTT，大小 = 速率 */
export function SkyChart({ conns, onSelect }: { conns: Conn[]; onSelect: (id: string) => void }) {
  const c = useColors()
  const stars = useMemo(() => conns.filter((x) => x.direction !== 'listen' && x.pid !== 0), [conns])

  const { option, ids } = useMemo(() => {
    // 同名进程（如多个 chrome.exe）共用一个扇区。正上方（0°）留空给 RTT 刻度，星点不会盖住刻度文字
    const names = [...new Set(stars.map((s) => s.procName))].sort((a, b) => a.localeCompare(b))
    const step = 360 / (names.length + 1)
    const sector = new Map(names.map((n, i) => [n, i + 1]))
    const volume = new Map<string, number>()
    for (const s of stars) volume.set(s.procName, (volume.get(s.procName) ?? 0) + s.rxRate + s.txRate + 1)
    const labeled = new Set([...volume.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LABELS).map(([n]) => n))
    const ids: string[][] = GROUPS.map(() => [])
    const groupData: (number | string)[][][] = GROUPS.map(() => [])

    for (const conn of stars) {
      const g = (GROUPS as readonly string[]).indexOf(conn.l7)
      const gi = g === -1 ? GROUPS.length - 1 : g
      const angle = (sector.get(conn.procName) ?? 1) * step + (hash01(conn.id) - 0.5) * step * 0.74
      const rate = conn.rxRate + conn.txRate
      const size = Math.min(26, 8 + Math.sqrt(rate) / 90)
      ids[gi].push(conn.id)
      groupData[gi].push([toRadius(conn), angle, size, conn.id])
    }

    const color = (g: string) => c(g === '其他' ? '--p-other' : L7_COLOR[g as keyof typeof L7_COLOR])
    const option = {
      animation: false,
      polar: { radius: '74%', center: ['50%', '50%'] },
      angleAxis: {
        type: 'value',
        min: 0,
        max: 360,
        interval: step,
        startAngle: 90,
        clockwise: true,
        axisLine: { lineStyle: { color: c('--line-strong') } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: c('--fg-2'),
          fontSize: 10,
          fontFamily: c('--font-data'),
          hideOverlap: true,
          formatter: (v: number) => {
            const full = names[Math.round(v / step) - 1] ?? ''
            if (!labeled.has(full)) return ''
            const name = full.replace(/\.exe$/i, '')
            return name.length > 9 ? `${name.slice(0, 8)}…` : name
          },
        },
      },
      radiusAxis: {
        type: 'value',
        min: 0,
        max: 5,
        interval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: c('--line') } },
        axisLabel: {
          color: c('--fg-3'),
          fontSize: 9,
          fontFamily: c('--font-data'),
          formatter: (v: number) => RING_LABEL[v] ?? '',
        },
      },
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(c),
        formatter: (p: { seriesName: string; data: [number, number, number, string] }) => {
          const conn = stars.find((s) => s.id === p.data[3])
          if (!conn) return ''
          return `<b>${conn.procName}</b> → ${conn.host}<br/><span style="color:${c('--fg-3')}">${conn.l7} · ${conn.state}</span><br/>RTT ${formatRtt(conn.rttMs)} · ↓ ${formatRate(conn.rxRate)} · ↑ ${formatRate(conn.txRate)}`
        },
      },
      series: GROUPS.map((g, i) => ({
        id: g,
        name: g,
        type: 'scatter',
        coordinateSystem: 'polar',
        symbol: g === '其他' ? 'circle' : L7_SYMBOL[g as keyof typeof L7_SYMBOL],
        symbolSize: (d: number[]) => d[2],
        // “其他”画成空心环：填充用面板底色，描边用协议色
        itemStyle: g === '其他'
          ? { color: c('--panel'), borderColor: color(g), borderWidth: 2 }
          : { color: color(g), borderColor: c('--panel'), borderWidth: 1, opacity: 0.92 },
        emphasis: { scale: 1.3 },
        data: groupData[i],
      })),
    }
    return { option, ids }
  }, [stars, c])

  return (
    <Panel
      title="连接星图"
      hint={`${stars.length} 颗`}
      className="h-[340px] xl:h-auto"
      right={<span className="text-[11px] text-fg-3">方位 进程 · 距离 RTT · 大小 速率</span>}
    >
      <div className="sky-frame absolute inset-x-0 bottom-6 top-0">
        <div className="sky-sweep" aria-hidden="true" />
        <EChart
          option={option}
          label={`连接星图，共 ${stars.length} 条活动连接，同样的数据可在连接表中查看`}
          onItemClick={(p) => {
            const id = p.seriesIndex !== undefined ? ids[p.seriesIndex]?.[p.dataIndex] : undefined
            if (id) onSelect(id)
          }}
        />
      </div>
      <div className="data absolute inset-x-0 bottom-1 flex flex-wrap justify-center gap-x-3 text-[10px] text-fg-2">
        {GROUPS.map((g) => (
          <span key={g} className="flex items-center gap-1">
            <span aria-hidden="true" style={{ color: g === '其他' ? 'var(--p-other)' : L7_COLOR[g as keyof typeof L7_COLOR] }}>{LEGEND_GLYPH[g]}</span>
            {g}
          </span>
        ))}
      </div>
    </Panel>
  )
}
