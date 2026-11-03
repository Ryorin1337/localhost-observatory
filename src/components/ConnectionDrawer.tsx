import { useMemo } from 'react'
import type { FilterKey } from '../lib/filter'
import { formatBytes, formatClock, formatDuration, formatEndpoint, formatRate, formatRtt } from '../lib/format'
import { FAILURE_LABEL, L7_COLOR, STATE_META, TONE_VAR } from '../lib/meta'
import { aggregate, type Snapshot } from '../lib/store'
import type { Conn } from '../lib/types'
import { StateBadge } from './StateBadge'
import { ThroughputChart } from './ThroughputChart'

/** CLOSE_WAIT 超过这个时长，基本可以判定进程没有 close() */
const CLOSE_WAIT_ALERT_MS = 30_000

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line px-4 py-3">
      <h3 className="eyebrow mb-2">{title}</h3>
      {children}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-fg-3">{label}</div>
      <div className="data truncate text-[13px] text-fg">{value}</div>
    </div>
  )
}

function Diagnosis({ conn, now }: { conn: Conn; now: number }) {
  let text: string | null = null
  let color = 'var(--serious)'
  let glyph = '▲'
  if (conn.failure) {
    color = 'var(--critical)'
    glyph = '✕'
    if (conn.failure === 'timeout') text = `${FAILURE_LABEL.timeout}：SYN 重传后依然没有响应。检查目标地址是否可达，以及防火墙是否丢弃了报文。`
    else if (conn.failure === 'refused') text = `${FAILURE_LABEL.refused}：对端返回了 RST，通常是目标端口没有服务在监听。`
    else text = `${FAILURE_LABEL.failed}：握手没有完成，连接就从系统表里消失了。系统不提供原因，常见情况是对端没有响应或拒绝了连接。`
  } else if (conn.state === 'CLOSE_WAIT') {
    const since = conn.transitions[conn.transitions.length - 1].t
    if (now - since > CLOSE_WAIT_ALERT_MS) {
      text = `已在 CLOSE_WAIT 停留 ${formatDuration(now - since)}。对端已经关闭，但 ${conn.procName}（PID ${conn.pid}）一直没有调用 close()，很可能是连接泄漏。`
    }
  } else if (conn.retrans >= 20) {
    text = `累计重传 ${conn.retrans} 次，这条链路可能存在丢包。`
  }
  if (!text) return null
  return (
    <div className="border-t border-line px-4 py-2.5 text-[12.5px] leading-relaxed text-fg" role="status">
      <span aria-hidden="true" className="mr-1.5" style={{ color }}>{glyph}</span>
      {text}
    </div>
  )
}

export function ConnectionDrawer({ conn, snap, onClose, onFilter, onShowInTree }: {
  conn: Conn
  snap: Snapshot
  onClose: () => void
  onFilter: (key: FilterKey, value: string) => void
  onShowInTree: (pid: number) => void
}) {
  const series = useMemo(() => aggregate([conn], snap, 60), [conn, snap])
  const now = snap.t
  const lastT = conn.endedAt ?? now

  return (
    <aside
      aria-label="连接详情"
      className="drawer-in thin-scroll fixed inset-y-0 right-0 z-20 w-full overflow-y-auto border-l border-line-strong bg-panel sm:w-[420px]"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <header className="flex items-start gap-3 px-4 pb-3 pt-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <StateBadge state={conn.state} failure={conn.failure} />
            <span className="flex items-center gap-1.5 text-[12px] text-fg-2">
              <i className="h-1.5 w-1.5 rounded-full" style={{ background: L7_COLOR[conn.l7] }} />
              {conn.l7} <span className="data text-[10px] text-fg-3">{conn.l4}</span>
            </span>
          </div>
          <h2 className="mt-1 break-all text-[17px] font-semibold leading-snug">{conn.host}</h2>
          <button onClick={() => onFilter('proc', conn.procName)} className="text-[12px] text-fg-2 hover:text-accent" title={`只看 ${conn.procName}`}>
            {conn.procName} <span className="data text-fg-3">PID {conn.pid}</span>
          </button>
          <button onClick={() => onShowInTree(conn.pid)} className="ml-3 text-[12px] text-fg-3 hover:text-accent">在进程树中查看</button>
        </div>
        <button onClick={onClose} aria-label="关闭连接详情（Esc）" className="rounded-[3px] px-2 py-0.5 text-[18px] leading-none text-fg-3 hover:bg-raise hover:text-fg">×</button>
      </header>

      <Diagnosis conn={conn} now={now} />

      <Section title="端点">
        <div className="data grid gap-1 text-[12px]">
          <div className="flex justify-between gap-3"><span className="text-fg-3">本地</span><span className="break-all text-right">{formatEndpoint(conn.localIp, conn.localPort)}</span></div>
          {conn.direction !== 'listen' && (
            <div className="flex justify-between gap-3"><span className="text-fg-3">{conn.direction === 'in' ? '来源' : '远端'}</span><span className="break-all text-right">{formatEndpoint(conn.remoteIp, conn.remotePort)}</span></div>
          )}
        </div>
      </Section>

      {conn.direction !== 'listen' && (
        <>
          <Section title="流量">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="↓ 下载" value={formatRate(conn.rxRate)} />
              <Stat label="↑ 上传" value={formatRate(conn.txRate)} />
              <Stat label="RTT" value={formatRtt(conn.rttMs)} />
              <Stat label="累计接收" value={formatBytes(conn.rxBytes)} />
              <Stat label="累计发送" value={formatBytes(conn.txBytes)} />
              <Stat label="重传" value={conn.l4 === 'TCP' ? String(conn.retrans) : '—'} />
            </div>
            <div className="relative mt-3 h-[130px]">
              <ThroughputChart series={series} compact />
            </div>
          </Section>
        </>
      )}

      <Section title="生命周期">
        <ol>
          {conn.transitions.map((tr, i) => {
            const next = conn.transitions[i + 1]?.t ?? lastT
            const current = i === conn.transitions.length - 1
            const failed = conn.failure && tr.state === 'CLOSED'
            const color = failed ? 'var(--critical)' : TONE_VAR[STATE_META[tr.state].tone]
            return (
              <li key={`${tr.state}-${tr.t}`} className="relative flex gap-2.5 pb-2 last:pb-0">
                {!current && <span className="absolute bottom-0 left-[5px] top-4 w-px bg-line-strong" aria-hidden="true" />}
                <span aria-hidden="true" className="w-[11px] text-center text-[11px] leading-5" style={{ color }}>{failed ? '✕' : STATE_META[tr.state].glyph}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`data text-[12px] ${current ? 'font-medium text-fg' : 'text-fg-2'}`}>{tr.state === 'UDP_ACTIVE' ? 'UDP 流活动' : tr.state}</span>
                    <span className="data text-[11px] text-fg-3">{formatClock(tr.t)}</span>
                  </div>
                  {tr.state !== 'CLOSED' && (
                    <div className="data text-[11px] text-fg-3">{current ? '已停留 ' : '停留 '}{formatDuration(next - tr.t)}</div>
                  )}
                  {current && <div className="mt-0.5 text-[12px] text-fg-2">{failed ? FAILURE_LABEL[conn.failure!] : STATE_META[tr.state].hint}</div>}
                </div>
              </li>
            )
          })}
        </ol>
      </Section>

      <Section title="协议识别">
        <p className="mb-2 text-[12px] text-fg-2">依据：{conn.inspect.identifiedBy}</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]">
          {conn.inspect.fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-3">{k}</dt>
              <dd className="data break-all text-right text-fg">{v}</dd>
            </div>
          ))}
        </dl>
        {conn.inspect.requests && (
          <ul className="data mt-3 border-t border-line text-[11px]">
            {conn.inspect.requests.map((r) => (
              <li key={`${r.t}-${r.path}`} className="flex gap-2 border-b border-line py-1">
                <span className="w-9 text-fg-2">{r.method}</span>
                <span className="min-w-0 flex-1 truncate text-fg" title={r.path}>{r.path}</span>
                <span className="text-fg-2" title={r.status === 0 ? '没有观察到响应' : undefined}>{r.status === 0 ? '—' : r.status >= 400 ? <><span aria-hidden="true" style={{ color: 'var(--serious)' }}>▲ </span>{r.status}</> : r.status}</span>
                <span className="w-10 text-right text-fg-3">{r.status === 0 ? '' : `${r.ms} ms`}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </aside>
  )
}
