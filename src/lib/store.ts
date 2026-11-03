import { useSyncExternalStore } from 'react'
import type { CaptureInfo, Conn, DataSource, Frame, Hello, ProcInfo, SourceStatus, StateEvent } from './types'

export interface RatePoint {
  t: number
  rx: number
  tx: number
}

export interface Snapshot {
  t: number
  procs: ProcInfo[]
  conns: Conn[]
  connById: Map<string, Conn>
  events: StateEvent[]
  /** 每条连接的逐秒速率，用来按任意过滤条件重新汇总曲线 */
  connHistory: Map<string, RatePoint[]>
  simulated: boolean
  sourceLabel: string
  paused: boolean
  status: SourceStatus
  capture: CaptureInfo | null
}

const HISTORY_SECONDS = 300
const MAX_EVENTS = 300

class Store {
  private listeners = new Set<() => void>()
  private snapshot: Snapshot = {
    t: 0, procs: [], conns: [], connById: new Map(), events: [], connHistory: new Map(),
    simulated: false, sourceLabel: '', paused: false, status: 'connecting', capture: null,
  }
  private latest: Frame | null = null
  private procs: ProcInfo[] = []
  private capture: CaptureInfo | null = null
  private events: StateEvent[] = []
  private connHistory = new Map<string, RatePoint[]>()
  private paused = false
  private status: SourceStatus = 'connecting'
  private source: DataSource | null = null
  /** 已经处理到的帧时间。订阅和取历史之间到达的帧可能已经包含在历史里，要丢掉 */
  private lastT = 0

  connect(source: DataSource) {
    this.source = source
    this.snapshot = { ...this.snapshot, simulated: source.simulated, sourceLabel: source.label }
    return source.start({
      onFrame: (f) => this.ingest(f),
      onHello: (h) => this.hello(h),
      onStatus: (s) => this.setStatus(s),
    })
  }

  /** 后端可能重启过，连接 ID 不再对应，所以旧数据全部换掉 */
  private hello(h: Hello) {
    this.latest = null
    this.lastT = h.t
    this.procs = h.procs
    this.capture = h.capture
    this.events = h.events.slice(0, MAX_EVENTS)
    this.connHistory = new Map(h.history.map(({ id, points }) => [id, points.map(([t, rx, tx]) => ({ t, rx, tx }))]))
    this.snapshot = { ...this.snapshot, t: h.t, procs: h.procs, capture: h.capture, events: this.events, connHistory: this.connHistory }
    this.notify()
  }

  private setStatus(status: SourceStatus) {
    this.status = status
    this.snapshot = { ...this.snapshot, status }
    this.notify()
  }

  private notify() {
    this.listeners.forEach((l) => l())
  }

  private ingest(frame: Frame) {
    if (frame.t <= this.lastT) return
    this.lastT = frame.t
    this.latest = frame
    if (frame.procs) this.procs = frame.procs
    this.capture = frame.capture
    const fresh = frame.events.slice().sort((a, b) => b.t - a.t)
    this.events = [...fresh, ...this.events].slice(0, MAX_EVENTS)

    const seen = new Set<string>()
    for (const c of frame.conns) {
      seen.add(c.id)
      if (c.direction === 'listen') continue
      let h = this.connHistory.get(c.id)
      if (!h) this.connHistory.set(c.id, (h = []))
      h.push({ t: frame.t, rx: c.rxRate, tx: c.txRate })
      if (h.length > HISTORY_SECONDS) h.shift()
    }
    for (const id of this.connHistory.keys()) if (!seen.has(id)) this.connHistory.delete(id)

    if (!this.paused) this.publish()
  }

  private publish() {
    const f = this.latest
    if (!f) return
    this.snapshot = {
      t: f.t,
      procs: this.procs,
      conns: f.conns,
      connById: new Map(f.conns.map((c) => [c.id, c])),
      events: this.events,
      connHistory: this.connHistory,
      simulated: this.source?.simulated ?? false,
      sourceLabel: this.source?.label ?? '',
      paused: this.paused,
      status: this.status,
      capture: this.capture,
    }
    this.notify()
  }

  setPaused(paused: boolean) {
    this.paused = paused
    if (paused) {
      this.snapshot = { ...this.snapshot, paused: true }
      this.notify()
    } else {
      this.snapshot = { ...this.snapshot, paused: false }
      this.publish()
      this.notify()
    }
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  get = () => this.snapshot
}

export const store = new Store()

export function useSnapshot() {
  return useSyncExternalStore(store.subscribe, store.get)
}

/** 把一组连接的逐秒速率加总成一条曲线，暂停时截止到快照时刻 */
export function aggregate(conns: Conn[], snap: Snapshot, seconds = 180): RatePoint[] {
  const end = Math.floor(snap.t / 1000)
  const start = end - seconds + 1
  const pts: RatePoint[] = Array.from({ length: seconds }, (_, i) => ({ t: (start + i) * 1000, rx: 0, tx: 0 }))
  for (const c of conns) {
    const h = snap.connHistory.get(c.id)
    if (!h) continue
    for (let i = h.length - 1; i >= 0; i--) {
      const idx = Math.floor(h[i].t / 1000) - start
      if (idx < 0) break
      if (idx >= seconds) continue
      pts[idx].rx += h[i].rx
      pts[idx].tx += h[i].tx
    }
  }
  return pts
}
