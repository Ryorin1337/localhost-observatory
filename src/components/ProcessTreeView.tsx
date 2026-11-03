import { useMemo, useState } from 'react'
import { hasToken, type FilterKey } from '../lib/filter'
import { formatBytes, formatClock, formatDuration, formatRate } from '../lib/format'
import { isLive, L7_COLOR } from '../lib/meta'
import { aggregate, type Snapshot } from '../lib/store'
import { ancestry, buildForest, busiest, findNode, flatten, hasNetwork, subtreePids, type TreeNode, type TreeRow } from '../lib/tree'
import type { Conn } from '../lib/types'
import { Panel } from './Panel'
import { StateBadge } from './StateBadge'
import { ThroughputChart } from './ThroughputChart'

const INDENT = 18
const ROW_H = 30
const TOP_PEERS = 2
const COLUMNS = 'minmax(280px,1fr) 56px 92px 92px 132px minmax(170px,240px)'

/** 一行左侧的连线：祖先竖线 + 指向自己的拐角 */
function Guides({ row }: { row: TreeRow }) {
  if (row.depth === 0) return null
  return (
    <svg width={INDENT * row.depth} height={ROW_H} className="shrink-0" aria-hidden="true">
      {row.guides.slice(1).map((on, i) =>
        on ? <line key={i} x1={INDENT * i + 8.5} x2={INDENT * i + 8.5} y1={0} y2={ROW_H} stroke="var(--line-strong)" /> : null,
      )}
      <path
        d={`M${INDENT * (row.depth - 1) + 8.5} 0 V${row.isLast ? ROW_H / 2 : ROW_H} M${INDENT * (row.depth - 1) + 8.5} ${ROW_H / 2} H${INDENT * row.depth}`}
        fill="none"
        stroke="var(--line-strong)"
      />
    </svg>
  )
}

/** 主要对端：按当前流量排序，去重 */
function topPeers(conns: Conn[], pid: number) {
  const byHost = new Map<string, number>()
  if (pid === 0) return { shown: [], more: 0 }
  for (const c of conns) {
    if (c.pid !== pid || c.direction === 'listen' || !isLive(c)) continue
    byHost.set(c.host, (byHost.get(c.host) ?? 0) + c.rxRate + c.txRate + 1)
  }
  const sorted = [...byHost.entries()].sort((a, b) => b[1] - a[1]).map(([host]) => host)
  return { shown: sorted.slice(0, TOP_PEERS), more: Math.max(0, sorted.length - TOP_PEERS) }
}

function Row({ row, conns, selected, onSelect, onToggle }: {
  row: TreeRow
  conns: Conn[]
  selected: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  const { node } = row
  const active = node.own.conns + node.own.listens > 0
  const showTotal = node.children.length > 0 && hasNetwork(node) && (node.total.rx !== node.own.rx || node.total.tx !== node.own.tx)
  const peers = topPeers(conns, node.proc.pid)

  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? !row.collapsed : undefined}
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect()
        if (row.hasChildren && ((e.key === 'ArrowLeft' && !row.collapsed) || (e.key === 'ArrowRight' && row.collapsed))) {
          e.preventDefault()
          onToggle()
        }
      }}
      className={`grid cursor-pointer items-center border-b border-line transition-colors hover:bg-raise ${selected ? 'bg-wash' : ''}`}
      style={{ gridTemplateColumns: COLUMNS, height: ROW_H }}
    >
      <div className="flex min-w-0 items-center pl-2">
        <Guides row={row} />
        {row.hasChildren ? (
          <button
            tabIndex={-1}
            aria-label={row.collapsed ? `展开 ${node.proc.name}` : `折叠 ${node.proc.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[2px] border border-line-strong bg-panel text-[10px] leading-none text-fg-2 hover:text-fg"
          >
            {row.collapsed ? '+' : '−'}
          </button>
        ) : (
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center" aria-hidden="true">
            <i className="block h-[7px] w-[7px] rounded-full border" style={active ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : { borderColor: 'var(--line-strong)' }} />
          </span>
        )}
        <span className={`ml-1.5 truncate text-[12.5px] ${active ? 'font-semibold text-fg' : 'text-fg-2'}`}>{node.proc.name}</span>
        <span className="data ml-1.5 shrink-0 text-[11px] text-fg-3">{node.proc.pid}</span>
        {node.orphaned && (
          <span className="ml-1.5 shrink-0 text-[10.5px] text-fg-3" title={`上报的父进程 PID ${node.proc.ppid} 已退出，或这个 PID 已被其他进程复用`}>父进程已退出</span>
        )}
      </div>
      <div className="data px-2 text-right text-[11px] text-fg-2">{node.own.conns + node.own.listens || '—'}</div>
      <div className="data whitespace-nowrap px-2 text-right text-[11px] text-fg-2">{formatRate(node.own.rx)}</div>
      <div className="data whitespace-nowrap px-2 text-right text-[11px] text-fg-2">{formatRate(node.own.tx)}</div>
      <div className="data whitespace-nowrap px-2 text-right text-[11px] text-fg-3">
        {showTotal ? <>↓{formatRate(node.total.rx)}</> : ''}
      </div>
      <div className="truncate px-2 text-[11.5px] text-fg-2">
        {peers.shown.join('，')}
        {peers.more > 0 && <span className="data text-fg-3"> +{peers.more}</span>}
      </div>
    </div>
  )
}

function Detail({ node, snap, conns, query, onSelectPid, onSelectConn, onFilter }: {
  node: TreeNode
  snap: Snapshot
  conns: Conn[]
  query: string
  onSelectPid: (pid: number) => void
  onSelectConn: (id: string) => void
  onFilter: (key: FilterKey, value: string) => void
}) {
  const pids = useMemo(() => subtreePids(node), [node])
  const own = useMemo(() => conns.filter((c) => c.pid === node.proc.pid && isLive(c)), [conns, node.proc.pid])
  const subtreeConns = useMemo(() => conns.filter((c) => pids.has(c.pid)), [conns, pids])
  const series = useMemo(() => aggregate(subtreeConns, snap, 60), [subtreeConns, snap])
  const listening = own.filter((c) => c.direction === 'listen')
  const flows = own.filter((c) => c.direction !== 'listen').sort((a, b) => b.rxRate + b.txRate - (a.rxRate + a.txRate))
  const pidValue = String(node.proc.pid)
  const filtering = hasToken(query, 'proc', pidValue)

  return (
    <div className="thin-scroll absolute inset-0 overflow-y-auto">
      <div className="px-3 pb-3">
        <nav aria-label="祖先进程" className="data flex flex-wrap items-center gap-x-1 text-[11px] text-fg-3">
          {ancestry(node).map((n, i, all) => (
            <span key={n.proc.pid} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true">›</span>}
              {i === all.length - 1 ? (
                <span className="text-fg-2">{n.proc.name}</span>
              ) : (
                <button onClick={() => onSelectPid(n.proc.pid)} className="hover:text-accent">{n.proc.name}</button>
              )}
            </span>
          ))}
        </nav>
        <h3 className="mt-1 break-all text-[17px] font-semibold leading-snug">{node.proc.name}</h3>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-fg-3">PID</dt>
          <dd className="data text-fg">{node.proc.pid}<span className="text-fg-3">　父 {node.proc.ppid || '—'}</span></dd>
          <dt className="text-fg-3">启动</dt>
          <dd className="data text-fg">
            {node.proc.startedAt ? <>{formatClock(node.proc.startedAt)}<span className="text-fg-3">　运行 {formatDuration(Math.max(0, snap.t - node.proc.startedAt))}</span></> : '—'}
          </dd>
          <dt className="text-fg-3">资源</dt>
          <dd className="data text-fg">CPU {node.proc.cpuPercent.toFixed(1)}%　内存 {formatBytes(node.proc.memoryBytes)}</dd>
          <dt className="text-fg-3">路径</dt>
          <dd className="data break-all text-[11px] text-fg-2">{node.proc.exe || '无权读取'}</dd>
          <dt className="text-fg-3">命令行</dt>
          <dd className="data max-h-24 overflow-y-auto break-all text-[11px] text-fg-2">{node.proc.cmd || '无权读取'}</dd>
        </dl>
        <button
          aria-pressed={filtering}
          onClick={() => onFilter('proc', pidValue)}
          className={`mt-2.5 rounded-[3px] border px-2 py-[3px] text-[12px] transition-colors ${filtering ? 'border-accent bg-wash text-fg' : 'border-line-strong text-fg-2 hover:text-fg'}`}
        >
          {filtering ? '取消过滤这个进程' : '全局过滤这个进程'}
        </button>
      </div>

      <section className="border-t border-line px-3 py-2.5">
        <h4 className="eyebrow mb-1.5">网络</h4>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <div>
            <div className="text-[11px] text-fg-3">本进程</div>
            <div className="data text-[12px] text-fg">↓ {formatRate(node.own.rx)}</div>
            <div className="data text-[12px] text-fg">↑ {formatRate(node.own.tx)}</div>
          </div>
          <div>
            <div className="text-[11px] text-fg-3">含子进程（{pids.size} 个）</div>
            <div className="data text-[12px] text-fg">↓ {formatRate(node.total.rx)}</div>
            <div className="data text-[12px] text-fg">↑ {formatRate(node.total.tx)}</div>
          </div>
        </div>
        <div className="relative mt-2 h-[120px]">
          <ThroughputChart series={series} compact />
        </div>
      </section>

      {listening.length > 0 && (
        <section className="border-t border-line px-3 py-2.5">
          <h4 className="eyebrow mb-1.5">监听端口 <span className="data font-normal">{listening.length}</span></h4>
          <div className="flex flex-wrap gap-1">
            {listening.map((c) => (
              <button key={c.id} onClick={() => onSelectConn(c.id)} className="data rounded-[2px] border border-line px-1.5 py-0.5 text-[11px] text-fg-2 hover:border-line-strong hover:text-fg" title={c.localIp}>
                {c.l4} {c.localPort}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="border-t border-line px-3 py-2.5">
        <h4 className="eyebrow mb-1.5">活动连接 <span className="data font-normal">{flows.length}</span></h4>
        {flows.length === 0 ? (
          <p className="text-[12px] text-fg-3">这个进程当前没有活动连接。</p>
        ) : (
          <ul>
            {flows.map((c) => (
              <li key={c.id}>
                <button onClick={() => onSelectConn(c.id)} className="block w-full rounded-[2px] border-t border-line py-1 text-left hover:bg-raise">
                  <span className="flex items-baseline gap-2">
                    <i className="h-1.5 w-1.5 shrink-0 self-center rounded-full" style={{ background: L7_COLOR[c.l7] }} />
                    <span className="truncate text-[12px] text-fg">{c.host}</span>
                    <span className="data ml-auto shrink-0 text-[10.5px] text-fg-3">:{c.remotePort}</span>
                  </span>
                  <span className="flex items-center justify-between gap-2 pl-3.5">
                    <StateBadge state={c.state} failure={c.failure} />
                    <span className="data whitespace-nowrap text-[10.5px] text-fg-2">↓ {formatRate(c.rxRate)}　↑ {formatRate(c.txRate)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export function ProcessTreeView({ snap, conns, query, selectedPid, onSelectPid, onSelectConn, onFilter }: {
  snap: Snapshot
  /** 已应用全局过滤 */
  conns: Conn[]
  query: string
  selectedPid: number | null
  onSelectPid: (pid: number) => void
  onSelectConn: (id: string) => void
  onFilter: (key: FilterKey, value: string) => void
}) {
  const [onlyNetwork, setOnlyNetwork] = useState(true)
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set())

  const roots = useMemo(() => buildForest(snap.procs, conns), [snap.procs, conns])
  // 有过滤条件时只留匹配到连接的分支，否则满屏都是无关进程
  const pruned = onlyNetwork || query.trim() !== ''
  const rows = useMemo(() => flatten(roots, collapsed, pruned), [roots, collapsed, pruned])
  const selected = (selectedPid !== null ? findNode(roots, selectedPid) : null) ?? busiest(roots)
  const withNet = useMemo(() => new Set(conns.filter((c) => isLive(c)).map((c) => c.pid)).size, [conns])

  const toggle = (pid: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(pid)) next.add(pid)
      return next
    })

  return (
    <div className="grid h-full gap-px bg-line xl:grid-cols-[minmax(0,1fr)_372px]">
      <Panel
        title="进程树"
        hint={`${snap.procs.length} 个进程 · ${withNet} 个有网络活动`}
        className="h-[70vh] xl:h-auto"
        right={
          <div className="flex items-center gap-3">
            <button onClick={() => setCollapsed(new Set())} className="text-[12px] text-fg-2 hover:text-fg">全部展开</button>
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg-2">
              <input id="tree-only-network" type="checkbox" checked={onlyNetwork} onChange={(e) => setOnlyNetwork(e.target.checked)} className="accent-[var(--accent)]" />
              只看有网络活动的分支
            </label>
          </div>
        }
      >
        {snap.procs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-fg-3">正在等待进程数据。</div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-fg-3">没有进程符合过滤条件。</div>
        ) : (
          <div className="thin-scroll absolute inset-0 overflow-auto">
            <div className="min-w-[880px]">
              <div className="sticky top-0 z-[1] grid items-center border-b border-line-strong bg-panel py-1" style={{ gridTemplateColumns: COLUMNS }}>
                <span className="eyebrow px-2">进程 / PID</span>
                <span className="eyebrow px-2 text-right">连接</span>
                <span className="eyebrow px-2 text-right">↓ 下载</span>
                <span className="eyebrow px-2 text-right">↑ 上传</span>
                <span className="eyebrow px-2 text-right" title="这个进程和全部子孙进程的下载合计">含子进程</span>
                <span className="eyebrow px-2">主要对端</span>
              </div>
              <div role="tree" aria-label="进程父子关系">
                {rows.map((row) => (
                  <Row
                    key={row.node.proc.pid}
                    row={row}
                    conns={conns}
                    selected={selected?.proc.pid === row.node.proc.pid}
                    onSelect={() => onSelectPid(row.node.proc.pid)}
                    onToggle={() => toggle(row.node.proc.pid)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </Panel>
      <Panel title="进程详情" className="h-[70vh] xl:h-auto">
        {selected ? (
          <Detail node={selected} snap={snap} conns={conns} query={query} onSelectPid={onSelectPid} onSelectConn={onSelectConn} onFilter={onFilter} />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-fg-3">选择一个进程查看详情。</div>
        )}
      </Panel>
    </div>
  )
}
