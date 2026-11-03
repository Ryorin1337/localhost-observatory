import type { Conn, ConnState, L7 } from './types'

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'quiet' | 'accent'

export const TONE_VAR: Record<Tone, string> = {
  good: 'var(--good)',
  warning: 'var(--warning)',
  serious: 'var(--serious)',
  critical: 'var(--critical)',
  neutral: 'var(--neutral)',
  quiet: 'var(--neutral-2)',
  accent: 'var(--accent)',
}

/** 状态的形状 + 颜色 + 文字一起表达，不只靠颜色 */
export const STATE_META: Record<ConnState, { glyph: string; tone: Tone; hint: string }> = {
  LISTEN: { glyph: '◎', tone: 'neutral', hint: '等待入站连接' },
  SYN_SENT: { glyph: '◔', tone: 'warning', hint: '已发出 SYN，等待对端响应' },
  SYN_RCVD: { glyph: '◔', tone: 'warning', hint: '收到 SYN，等待最后一个 ACK' },
  ESTABLISHED: { glyph: '●', tone: 'good', hint: '连接已建立，正常收发数据' },
  FIN_WAIT_1: { glyph: '◑', tone: 'neutral', hint: '本端已发 FIN，等待 ACK' },
  FIN_WAIT_2: { glyph: '◑', tone: 'neutral', hint: '等待对端的 FIN' },
  CLOSE_WAIT: { glyph: '▲', tone: 'serious', hint: '对端已关闭，本地进程还没调用 close()。长期停留通常是连接泄漏' },
  CLOSING: { glyph: '◑', tone: 'neutral', hint: '双方同时关闭，等待对端确认' },
  LAST_ACK: { glyph: '◑', tone: 'neutral', hint: '本端已发 FIN，等待最后一个 ACK' },
  TIME_WAIT: { glyph: '◌', tone: 'quiet', hint: '已关闭，等待 2MSL 让残留报文消失' },
  CLOSED: { glyph: '○', tone: 'quiet', hint: '连接已结束' },
  UDP_ACTIVE: { glyph: '◆', tone: 'accent', hint: 'UDP 无连接状态，这里按流活动追踪' },
  UDP_BOUND: { glyph: '◎', tone: 'neutral', hint: 'UDP 端口已绑定，还没有观察到流量' },
}

export const STATE_ORDER: ConnState[] = [
  'ESTABLISHED', 'SYN_SENT', 'SYN_RCVD', 'CLOSE_WAIT', 'FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSING', 'LAST_ACK', 'TIME_WAIT', 'UDP_ACTIVE', 'LISTEN', 'UDP_BOUND',
]

/** 状态名在界面上的写法 */
export function stateLabel(state: ConnState) {
  if (state === 'UDP_ACTIVE') return 'UDP'
  if (state === 'UDP_BOUND') return 'UDP 绑定'
  return state
}

export const MAIN_L7: L7[] = ['TLS', 'HTTP', 'DNS', 'QUIC']

export const L7_COLOR: Record<L7, string> = {
  TLS: 'var(--p-tls)',
  HTTP: 'var(--p-http)',
  DNS: 'var(--p-dns)',
  QUIC: 'var(--p-quic)',
  SSH: 'var(--p-other)',
  PostgreSQL: 'var(--p-other)',
  未识别: 'var(--p-other)',
}

/** 星图上的第二编码：协议同时用形状区分，色觉差异下也可读 */
export const L7_SYMBOL: Record<L7, string> = {
  TLS: 'circle',
  HTTP: 'rect',
  DNS: 'triangle',
  QUIC: 'diamond',
  SSH: 'circle',
  PostgreSQL: 'circle',
  未识别: 'circle',
}

export const FAILURE_LABEL = { timeout: '连接超时', refused: '连接被拒绝', failed: '建连失败' } as const
export const FAILURE_CODE = { timeout: 'TIMEOUT', refused: 'REFUSED', failed: 'FAILED' } as const

/** 稳定的 0–1 哈希：同一条连接每次都落在同一位置 */
export function hash01(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967295
}

export function isLive(c: Conn) {
  return c.state !== 'CLOSED'
}

/** 需要开发者注意的连接 */
export function isAttention(c: Conn) {
  return c.state === 'CLOSE_WAIT' || !!c.failure
}
