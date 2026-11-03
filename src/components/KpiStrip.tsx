import type { FilterKey } from '../lib/filter'
import { formatBytes, formatRate } from '../lib/format'
import type { RatePoint } from '../lib/store'
import type { Conn } from '../lib/types'

function Tile({ label, mark, value, sub, onClick }: {
  label: string
  mark?: React.ReactNode
  value: string
  sub: React.ReactNode
  onClick?: () => void
}) {
  const body = (
    <>
      <span className="eyebrow flex items-center gap-1.5">{mark}{label}</span>
      <span className="text-[26px] font-semibold leading-tight tracking-tight text-fg">{value}</span>
      <span className="data truncate text-[11px] text-fg-3">{sub}</span>
    </>
  )
  const cls = 'flex min-w-0 flex-col gap-0.5 bg-panel px-3 py-2 text-left'
  return onClick ? (
    <button onClick={onClick} className={`${cls} transition-colors hover:bg-raise`}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

const dot = (color: string, glyph: string) => <span aria-hidden="true" style={{ color }}>{glyph}</span>

export function KpiStrip({ live, visible, series, ratesKnown, onFilter }: {
  live: Conn[]
  visible: Conn[]
  series: RatePoint[]
  /** 拿不到速率时显示“—”，不能显示成 0 */
  ratesKnown: boolean
  onFilter: (key: FilterKey, value: string) => void
}) {
  const rx = live.reduce((s, c) => s + c.rxRate, 0)
  const tx = live.reduce((s, c) => s + c.txRate, 0)
  const peakRx = Math.max(...series.map((p) => p.rx))
  const peakTx = Math.max(...series.map((p) => p.tx))
  const totalRx = series.reduce((s, p) => s + p.rx, 0)
  const totalTx = series.reduce((s, p) => s + p.tx, 0)
  const tcp = live.filter((c) => c.l4 === 'TCP' && c.direction !== 'listen').length
  const udp = live.filter((c) => c.l4 === 'UDP' && c.direction !== 'listen').length
  const listening = live.filter((c) => c.direction === 'listen').length
  const closeWait = live.filter((c) => c.state === 'CLOSE_WAIT').length
  const failed = visible.filter((c) => c.failure).length
  const retrans = live.reduce((s, c) => s + c.retrans, 0)

  return (
    <div className="grid grid-cols-2 gap-px md:grid-cols-4">
      <Tile label="下载" mark={dot('var(--down)', '↓')} value={ratesKnown ? `${formatBytes(rx)}/s` : '—'} sub={ratesKnown ? `峰值 ${formatRate(peakRx)} · 3 分钟 ${formatBytes(totalRx)}` : '需要管理员权限'} />
      <Tile label="上传" mark={dot('var(--up)', '↑')} value={ratesKnown ? `${formatBytes(tx)}/s` : '—'} sub={ratesKnown ? `峰值 ${formatRate(peakTx)} · 3 分钟 ${formatBytes(totalTx)}` : '需要管理员权限'} />
      <Tile label="活动连接" value={String(tcp + udp)} sub={`TCP ${tcp} · UDP ${udp} · 监听 ${listening}`} />
      <Tile
        label="需要注意"
        mark={dot('var(--serious)', '▲')}
        value={String(closeWait + failed)}
        sub={`CLOSE_WAIT ${closeWait} · 建连失败 ${failed} · 重传 ${retrans}`}
        onClick={() => onFilter('state', 'attention')}
      />
    </div>
  )
}
