const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(n: number) {
  if (n < 1) return '0 B'
  const e = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1)
  const v = n / 1024 ** e
  return `${v >= 100 || e === 0 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${UNITS[e]}`
}

export function formatRate(n: number) {
  return n < 1 ? '—' : `${formatBytes(n)}/s`
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function formatClock(t: number) {
  return new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
}

export function formatRtt(ms: number) {
  if (!ms) return '—'
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`
}

export function formatEndpoint(ip: string, port: number) {
  return port ? `${ip}:${port}` : ip
}
