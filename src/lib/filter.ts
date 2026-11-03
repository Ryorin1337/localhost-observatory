import type { Conn } from './types'
import { isAttention, MAIN_L7 } from './meta'

// 过滤语法：proc:node ip:203.0 port:443 state:established proto:tls，其余词做全文匹配。
export const FILTER_KEYS = ['proc', 'ip', 'port', 'state', 'proto'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]

export interface Token {
  key: FilterKey | 'text'
  value: string
}

export function parseQuery(query: string): Token[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf(':')
      const key = part.slice(0, i).toLowerCase()
      const value = part.slice(i + 1)
      return i > 0 && value && (FILTER_KEYS as readonly string[]).includes(key)
        ? { key: key as FilterKey, value: value.toLowerCase() }
        : { key: 'text' as const, value: part.toLowerCase() }
    })
}

function matchToken(c: Conn, { key, value }: Token): boolean {
  switch (key) {
    case 'proc':
      return c.procName.toLowerCase().includes(value) || String(c.pid) === value
    case 'ip':
      return c.remoteIp.includes(value) || c.localIp.includes(value)
    case 'port':
      return String(c.remotePort) === value || String(c.localPort) === value
    case 'state':
      if (value === 'failed') return !!c.failure
      if (value === 'attention') return isAttention(c)
      return c.state.toLowerCase().includes(value)
    case 'proto':
      if (value === 'other') return !MAIN_L7.includes(c.l7)
      return c.l4.toLowerCase() === value || c.l7.toLowerCase() === value
    default:
      return [c.procName, String(c.pid), c.host, c.remoteIp, c.localIp, String(c.remotePort), String(c.localPort), c.state, c.l7, c.l4]
        .some((s) => s.toLowerCase().includes(value))
  }
}

export function matches(c: Conn, tokens: Token[]) {
  return tokens.every((t) => matchToken(c, t))
}

/** 点击进程、IP、端口、协议时切换对应的过滤词；同 key 的旧值会被替换 */
export function toggleToken(query: string, key: FilterKey, value: string) {
  const v = value.toLowerCase()
  const tokens = parseQuery(query)
  const had = tokens.some((t) => t.key === key && t.value === v)
  const rest = tokens.filter((t) => t.key !== key)
  if (!had) rest.push({ key, value: v })
  return rest.map((t) => (t.key === 'text' ? t.value : `${t.key}:${t.value}`)).join(' ')
}

/** 失败的连接都已关闭，查它们时不能再隐藏已关闭的行 */
export function wantsClosed(tokens: Token[]) {
  return tokens.some((t) => t.key === 'state' && (t.value === 'failed' || t.value === 'attention' || t.value === 'closed'))
}

export function hasToken(query: string, key: FilterKey, value: string) {
  return parseQuery(query).some((t) => t.key === key && t.value === value.toLowerCase())
}
