// 前后端之间的数据契约，与 backend/src/model.rs 一一对应。
// 前端的 store 只依赖这里的类型，不关心数据来自采集器还是模拟器。

export type ConnState =
  | 'LISTEN'
  | 'SYN_SENT'
  | 'SYN_RCVD'
  | 'ESTABLISHED'
  | 'FIN_WAIT_1'
  | 'FIN_WAIT_2'
  | 'CLOSE_WAIT'
  | 'CLOSING'
  | 'LAST_ACK'
  | 'TIME_WAIT'
  | 'CLOSED'
  | 'UDP_ACTIVE'
  | 'UDP_BOUND'

export type L4 = 'TCP' | 'UDP'
export type L7 = 'TLS' | 'HTTP' | 'DNS' | 'QUIC' | 'SSH' | 'PostgreSQL' | '未识别'
export type Direction = 'out' | 'in' | 'listen'
export type Failure = 'timeout' | 'refused' | 'failed'

export interface Transition {
  state: ConnState
  t: number
}

export interface Inspection {
  /** 协议是靠什么特征识别出来的 */
  identifiedBy: string
  fields: [string, string][]
  /** 明文 HTTP 可见的最近请求 */
  requests?: { t: number; method: string; path: string; status: number; ms: number }[]
}

export interface Conn {
  id: string
  pid: number
  procName: string
  l4: L4
  l7: L7
  direction: Direction
  localIp: string
  localPort: number
  remoteIp: string
  remotePort: number
  host: string
  state: ConnState
  transitions: Transition[]
  startedAt: number
  endedAt?: number
  failure?: Failure
  /** bytes/s */
  rxRate: number
  txRate: number
  rxBytes: number
  txBytes: number
  /** 0 表示未知 */
  rttMs: number
  retrans: number
  inspect: Inspection
}

export interface ProcInfo {
  pid: number
  /** 上报的父 PID。父进程可能已退出，PID 也可能被复用，建树时要校验 */
  ppid: number
  name: string
  exe: string
  cmd: string
  startedAt: number
  memoryBytes: number
  cpuPercent: number
}

export interface StateEvent {
  t: number
  connId: string
  procName: string
  host: string
  from: ConnState | null
  to: ConnState
  failure?: Failure
}

/** 当前权限下哪些采集能力真正可用 */
export interface CaptureInfo {
  elevated: boolean
  rates: boolean
  dns: boolean
  payload: boolean
  rtt: boolean
  /** 采集没能启动的原因。旧版后端没有这个字段 */
  errors?: string[]
}

export interface Frame {
  t: number
  /** 进程表变化时才带 */
  procs?: ProcInfo[]
  /** 活动连接 + 最近关闭、仍在保留窗口内的连接 */
  conns: Conn[]
  /** 自上一帧以来发生的状态变化 */
  events: StateEvent[]
  capture: CaptureInfo
}

/** 连上后端时补发的历史 */
export interface Hello {
  t: number
  procs: ProcInfo[]
  events: StateEvent[]
  history: { id: string; points: [number, number, number][] }[]
  capture: CaptureInfo
}

export type SourceStatus = 'connecting' | 'live' | 'disconnected'

export interface SourceHandlers {
  onFrame(frame: Frame): void
  onHello(hello: Hello): void
  onStatus(status: SourceStatus): void
}

export interface DataSource {
  /** 数据来源的标签，显示在顶栏 */
  label: string
  simulated: boolean
  start(handlers: SourceHandlers): () => void
}
