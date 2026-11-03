import { formatClock } from '../lib/format'
import { store, type Snapshot } from '../lib/store'
import type { Theme } from '../lib/theme'

export type View = 'overview' | 'connections' | 'timeline' | 'tree'

const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'connections', label: '连接' },
  { id: 'timeline', label: '时间线' },
  { id: 'tree', label: '进程树' },
]

function SourceChip({ snap }: { snap: Snapshot }) {
  let glyph = '●'
  let color = 'var(--good)'
  let label = '实时'
  let title = '正在接收本机的真实数据'
  if (snap.simulated) {
    glyph = '◆'
    color = 'var(--warning)'
    label = `演示数据 · ${snap.sourceLabel}`
    title = '这是模拟数据，不是这台电脑的真实连接'
  } else if (snap.status === 'disconnected') {
    glyph = '✕'
    color = 'var(--critical)'
    label = '后端未连接'
    title = '正在自动重连'
  } else if (snap.status === 'connecting') {
    glyph = '◔'
    color = 'var(--warning)'
    label = '正在连接后端'
    title = ''
  } else if (snap.capture && !snap.capture.elevated) {
    glyph = '▲'
    color = 'var(--serious)'
    label = '实时 · 受限模式'
    title = '后端不是以管理员身份运行的'
  } else {
    label = `实时 · ${snap.sourceLabel}`
  }
  return (
    <span className="rounded-[3px] border border-line-strong px-2 py-0.5 text-[12px] font-medium text-fg" title={title}>
      <span aria-hidden="true" style={{ color }}>{glyph}</span> {label}
    </span>
  )
}

function Mark() {
  // 极坐标星图的缩影：本机在圆心，外圈是 RTT 距离环
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" stroke="var(--line-strong)" />
      <circle cx="12" cy="12" r="6" stroke="var(--line-strong)" />
      <path d="M12 12 L21.5 7.5 A10.5 10.5 0 0 0 12 1.5 Z" fill="var(--sweep)" />
      <circle cx="12" cy="12" r="1.8" fill="var(--accent)" />
      <circle cx="17.5" cy="6" r="1.2" fill="var(--fg)" />
    </svg>
  )
}

export function Header({ view, onView, snap, theme, onToggleTheme }: {
  view: View
  onView: (v: View) => void
  snap: Snapshot
  theme: Theme
  onToggleTheme: () => void
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-2.5">
      <div className="flex items-center gap-2">
        <Mark />
        <h1 className="wordmark whitespace-nowrap text-[21px] leading-none">Localhost Observatory</h1>
      </div>

      <nav className="flex gap-1" aria-label="视图">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            aria-current={view === v.id ? 'page' : undefined}
            onClick={() => onView(v.id)}
            className={`rounded-[3px] px-2.5 py-1 text-[13px] font-medium transition-colors ${
              view === v.id ? 'bg-wash text-accent' : 'text-fg-2 hover:bg-raise hover:text-fg'
            }`}
          >
            {v.label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <SourceChip snap={snap} />
        <span className="data text-[12px] text-fg-3">{snap.t ? formatClock(snap.t) : '--:--:--'}</span>
        <button
          onClick={() => store.setPaused(!snap.paused)}
          title="快捷键：空格"
          className={`flex items-center gap-1.5 rounded-[3px] border px-2.5 py-1 text-[12px] font-medium transition-colors ${
            snap.paused ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong text-fg-2 hover:text-fg'
          }`}
        >
          <span aria-hidden="true">{snap.paused ? '▶' : '❚❚'}</span>
          {snap.paused ? '继续' : '暂停'}
        </button>
        <button
          onClick={onToggleTheme}
          className="rounded-[3px] border border-line-strong px-2.5 py-1 text-[12px] font-medium text-fg-2 transition-colors hover:text-fg"
        >
          {theme === 'dark' ? '切到亮色' : '切到暗色'}
        </button>
      </div>
    </header>
  )
}
