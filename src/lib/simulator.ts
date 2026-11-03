// 模拟采集源：在后端接入之前，按真实的 TCP/UDP 生命周期生成一台开发机的网络活动。
// 公网地址全部取自 RFC 5737 文档保留网段（192.0.2/24、198.51.100/24、203.0.113/24）。

import type { CaptureInfo, Conn, ConnState, DataSource, Failure, Frame, Inspection, L4, L7, ProcInfo, SourceHandlers, StateEvent } from './types'

const RETAIN_CLOSED_MS = 5 * 60_000
const WARMUP_SECONDS = 300
const LOCAL_IP = '192.168.1.42'

interface Target {
  host: string
  ip: string
  port: number
  l4: L4
  l7: L7
  rtt: number
  /** 活跃时的平均速率 bytes/s */
  rx: number
  tx: number
  /** 平均每秒新建多少条 */
  spawn: number
  life: [number, number]
  /** 对端主动关闭后，本地进程不调用 close()，连接卡在 CLOSE_WAIT */
  leaks?: boolean
  /** 建连失败概率 */
  failRate?: number
  lossy?: boolean
  /** 启动时就在、长期存活的连接数 */
  pool?: number
  localPort?: number
  direction?: 'out' | 'in'
}

interface Profile extends ProcInfo {
  targets: Target[]
  listens?: { port: number; l7: L7 }[]
}

const tls = (host: string, ip: string, rtt: number, rx: number, tx: number, spawn: number, life: [number, number], extra: Partial<Target> = {}): Target => ({
  host, ip, port: 443, l4: 'TCP', l7: 'TLS', rtt, rx, tx, spawn, life, ...extra,
})
const quic = (host: string, ip: string, rtt: number, rx: number, tx: number, spawn: number, life: [number, number]): Target => ({
  host, ip, port: 443, l4: 'UDP', l7: 'QUIC', rtt, rx, tx, spawn, life,
})
const dns = (host: string, spawn: number): Target => ({
  host, ip: '192.0.2.53', port: 53, l4: 'UDP', l7: 'DNS', rtt: 11, rx: 240, tx: 90, spawn, life: [1, 3],
})

const proc = (pid: number, ppid: number, name: string, exe: string, args: string, ageMinutes: number, memoryMb: number, cpuPercent = 0): ProcInfo => ({
  pid, ppid, name, exe, cmd: args ? `${exe} ${args}` : exe,
  startedAt: BOOT - ageMinutes * 60_000, memoryBytes: memoryMb * 1024 * 1024, cpuPercent,
})
const BOOT = Date.now()

/** 没有网络活动、只构成父子关系的进程。PID 600 和 2900 故意不存在：它们的启动器早已退出 */
const CONTEXT_PROCS: ProcInfo[] = [
  proc(4, 0, 'System', '', '', 480, 0, 0.2),
  proc(700, 600, 'wininit.exe', 'C:\\Windows\\System32\\wininit.exe', '', 480, 2),
  proc(812, 700, 'services.exe', 'C:\\Windows\\System32\\services.exe', '', 480, 9),
  proc(3100, 2900, 'explorer.exe', 'C:\\Windows\\explorer.exe', '', 470, 180, 0.3),
  proc(5200, 3100, 'WindowsTerminal.exe', 'C:\\Program Files\\WindowsApps\\WindowsTerminal.exe', '', 210, 96, 0.1),
  proc(5300, 5200, 'pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo', 205, 74),
  proc(2840, 3100, 'chrome.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '', 300, 420, 1.1),
  proc(2901, 2840, 'chrome.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '--type=gpu-process', 300, 260, 0.8),
  proc(13440, 13390, 'rustc.exe', 'C:\\Users\\dev\\.rustup\\toolchains\\stable\\bin\\rustc.exe', '--crate-name observatory --edition=2021', 2, 610, 11.4),
]

const PROFILES: Profile[] = [
  {
    ...proc(2841, 2840, 'chrome.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '--type=utility --utility-sub-type=network.mojom.NetworkService', 300, 95, 0.6),
    targets: [
      quic('www.youtube.com', '198.51.100.14', 18, 1_900_000, 42_000, 0.03, [40, 160]),
      quic('fonts.gstatic.com', '198.51.100.27', 14, 160_000, 6_000, 0.08, [6, 24]),
      tls('github.com', '203.0.113.10', 34, 240_000, 22_000, 0.12, [8, 45]),
      tls('docs.rs', '203.0.113.71', 92, 120_000, 8_000, 0.06, [5, 22]),
      tls('stackoverflow.com', '203.0.113.88', 118, 90_000, 6_000, 0.05, [6, 30]),
      { host: 'localhost', ip: '127.0.0.1', port: 5173, l4: 'TCP', l7: 'HTTP', rtt: 0.2, rx: 180_000, tx: 12_000, spawn: 0.1, life: [2, 12] },
    ],
  },
  {
    ...proc(11872, 5300, 'node.exe', 'C:\\Program Files\\nodejs\\node.exe', 'node_modules\\vite\\bin\\vite.js --port 5173', 95, 210, 1.8),
    listens: [{ port: 5173, l7: 'HTTP' }],
    targets: [
      { host: 'localhost', ip: '127.0.0.1', port: 5432, l4: 'TCP', l7: 'PostgreSQL', rtt: 0.15, rx: 46_000, tx: 11_000, spawn: 0, life: [9999, 9999], pool: 4 },
      tls('registry.npmjs.org', '203.0.113.34', 46, 1_200_000, 18_000, 0.03, [6, 26]),
      tls('hooks.partner-api.test', '198.51.100.90', 210, 3_000, 2_000, 0.022, [5, 15], { leaks: true }),
      { host: 'localhost', ip: '127.0.0.1', port: 49000, l4: 'TCP', l7: 'HTTP', rtt: 0.2, rx: 12_000, tx: 180_000, spawn: 0.1, life: [2, 12], direction: 'in', localPort: 5173 },
    ],
  },
  {
    ...proc(13390, 5300, 'cargo.exe', 'C:\\Users\\dev\\.cargo\\bin\\cargo.exe', 'build --release', 2, 38, 0.4),
    targets: [
      tls('static.crates.io', '203.0.113.47', 58, 4_600_000, 30_000, 0.05, [4, 18]),
      tls('index.crates.io', '203.0.113.48', 58, 340_000, 12_000, 0.08, [2, 8]),
    ],
  },
  {
    ...proc(1204, 812, 'postgres.exe', 'C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe', '-D "C:\\Program Files\\PostgreSQL\\16\\data"', 478, 145, 0.5),
    listens: [{ port: 5432, l7: 'PostgreSQL' }],
    targets: [
      { host: 'localhost', ip: '127.0.0.1', port: 51000, l4: 'TCP', l7: 'PostgreSQL', rtt: 0.15, rx: 11_000, tx: 46_000, spawn: 0, life: [9999, 9999], pool: 4, direction: 'in', localPort: 5432 },
    ],
  },
  {
    ...proc(3377, 3100, 'Code.exe', 'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', '--type=utility --utility-sub-type=node.mojom.NodeService', 240, 530, 2.3),
    targets: [
      tls('marketplace.visualstudio.com', '203.0.113.120', 76, 60_000, 6_000, 0.03, [6, 30]),
      tls('api.githubcopilot.test', '198.51.100.120', 64, 80_000, 34_000, 0.1, [6, 28]),
    ],
  },
  {
    ...proc(4120, 3100, 'slack.exe', 'C:\\Users\\dev\\AppData\\Local\\slack\\slack.exe', '--enable-crashpad', 400, 340, 0.7),
    targets: [
      tls('wss-primary.slack.com', '198.51.100.61', 142, 5_000, 1_400, 0, [9999, 9999], { pool: 1 }),
      tls('files.slack-edge.test', '198.51.100.77', 268, 240_000, 6_000, 0.05, [4, 16], { failRate: 0.45, lossy: true }),
    ],
  },
  {
    ...proc(5502, 5300, 'ssh.exe', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'deploy@staging.internal', 88, 8),
    targets: [
      { host: 'staging.internal', ip: '10.20.0.15', port: 22, l4: 'TCP', l7: 'SSH', rtt: 6, rx: 3_200, tx: 900, spawn: 0, life: [9999, 9999], pool: 1 },
    ],
  },
  {
    ...proc(642, 812, 'svchost.exe', 'C:\\Windows\\System32\\svchost.exe', '-k NetworkService -p -s Dnscache', 479, 22, 0.1),
    targets: ['github.com', 'static.crates.io', 'registry.npmjs.org', 'docs.rs', 'wss-primary.slack.com', 'www.youtube.com'].map((h) => dns(h, 0.12)),
  },
]

/** 确定性随机数，同一种子每次演示都一样 */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Live extends Conn {
  plan: { state: ConnState; t: number; failure?: Failure }[]
  base: { rx: number; tx: number }
  burst: number
  lossy: boolean
}

const ACTIVE: ConnState[] = ['ESTABLISHED', 'UDP_ACTIVE']

export class Simulator implements DataSource {
  label = '模拟 ETW 采集'
  simulated = true
  private capture: CaptureInfo = { elevated: true, rates: true, dns: true, payload: true, rtt: true }
  private rand = mulberry32(20261103)
  private conns = new Map<string, Live>()
  private seq = 0
  private ephemeral = 41000
  private pendingEvents: StateEvent[] = []
  private procs: ProcInfo[] = [
    ...CONTEXT_PROCS,
    ...PROFILES.map(({ pid, ppid, name, exe, cmd, startedAt, memoryBytes, cpuPercent }) => ({ pid, ppid, name, exe, cmd, startedAt, memoryBytes, cpuPercent })),
  ]
  private bootstrapped = false

  start({ onFrame, onStatus }: SourceHandlers) {
    onStatus('live')
    const now = Date.now()
    this.bootstrap(now - WARMUP_SECONDS * 1000)
    // 补上一段历史，首屏就有完整的曲线和时间线
    for (let i = WARMUP_SECONDS; i >= 0; i--) onFrame(this.tick(now - i * 1000))
    // 用逻辑时钟逐秒推进，定时器抖动或后台节流时补帧，曲线不会缺点或重复
    let t = now
    const timer = setInterval(() => {
      while (t + 1000 <= Date.now()) onFrame(this.tick((t += 1000)))
    }, 250)
    return () => clearInterval(timer)
  }

  private bootstrap(t: number) {
    if (this.bootstrapped) return
    this.bootstrapped = true
    for (const p of PROFILES) {
      for (const l of p.listens ?? []) this.spawnListener(p, l.port, l.l7, t)
      for (const target of p.targets) {
        for (let i = 0; i < (target.pool ?? 0); i++) this.spawn(p, target, t - 1000 * (600 + this.rand() * 1800))
      }
    }
  }

  private range([a, b]: [number, number]) {
    return a + this.rand() * (b - a)
  }

  private spawnListener(p: Profile, port: number, l7: L7, t: number) {
    const id = `c${++this.seq}`
    const conn: Live = {
      id, pid: p.pid, procName: p.name, l4: 'TCP', l7, direction: 'listen',
      localIp: port === 5432 ? '127.0.0.1' : '0.0.0.0', localPort: port, remoteIp: '*', remotePort: 0, host: '监听中',
      state: 'LISTEN', transitions: [{ state: 'LISTEN', t }], startedAt: t,
      rxRate: 0, txRate: 0, rxBytes: 0, txBytes: 0, rttMs: 0, retrans: 0,
      inspect: { identifiedBy: `监听端口 ${port} + 入站流量特征`, fields: [['绑定地址', `${port === 5432 ? '127.0.0.1' : '0.0.0.0'}:${port}`], ['Backlog', '511']] },
      plan: [], base: { rx: 0, tx: 0 }, burst: 0, lossy: false,
    }
    this.conns.set(id, conn)
  }

  private spawn(p: Profile, target: Target, t: number) {
    const id = `c${++this.seq}`
    const direction = target.direction ?? 'out'
    const rtt = target.rtt * (0.85 + this.rand() * 0.3)
    const localPort = target.localPort ?? this.ephemeral++
    if (this.ephemeral > 60000) this.ephemeral = 41000
    const remotePort = direction === 'in' ? this.ephemeral++ : target.port
    const life = this.range(target.life) * 1000
    const plan: Live['plan'] = []
    let first: ConnState

    if (target.l4 === 'UDP') {
      first = 'UDP_ACTIVE'
      plan.push({ state: 'CLOSED', t: t + life })
    } else if (direction === 'in') {
      first = 'SYN_RCVD'
      plan.push({ state: 'ESTABLISHED', t: t + 400 + rtt })
      this.planClose(plan, t + life, rtt, false)
    } else if (this.rand() < (target.failRate ?? 0)) {
      first = 'SYN_SENT'
      const refused = this.rand() < 0.25
      plan.push({ state: 'CLOSED', t: t + (refused ? 800 + rtt : 21_000), failure: refused ? 'refused' : 'timeout' })
    } else {
      first = 'SYN_SENT'
      // 握手慢到肉眼可见（至少 800ms），否则 1Hz 采样看不到 SYN_SENT
      plan.push({ state: 'ESTABLISHED', t: t + 800 + rtt * 3 })
      if (target.leaks) {
        plan.push({ state: 'CLOSE_WAIT', t: t + life })
      } else {
        this.planClose(plan, t + life, rtt, this.rand() < 0.3)
      }
    }

    const conn: Live = {
      id, pid: p.pid, procName: p.name, l4: target.l4, l7: target.l7, direction,
      localIp: target.ip === '127.0.0.1' ? '127.0.0.1' : LOCAL_IP, localPort,
      remoteIp: target.ip, remotePort, host: target.host,
      state: first, transitions: [{ state: first, t }], startedAt: t,
      rxRate: 0, txRate: 0, rxBytes: 0, txBytes: 0, rttMs: rtt, retrans: 0,
      inspect: this.inspect(target, p, t),
      plan, base: { rx: target.rx, tx: target.tx }, burst: 0, lossy: !!target.lossy,
    }
    this.conns.set(id, conn)
    this.pendingEvents.push({ t, connId: id, procName: p.name, host: target.host, from: null, to: first })
  }

  private planClose(plan: Live['plan'], at: number, rtt: number, remoteFirst: boolean) {
    const step = Math.max(600, rtt * 4)
    if (remoteFirst) {
      plan.push({ state: 'CLOSE_WAIT', t: at }, { state: 'LAST_ACK', t: at + step }, { state: 'CLOSED', t: at + step * 2 })
    } else {
      plan.push(
        { state: 'FIN_WAIT_1', t: at },
        { state: 'FIN_WAIT_2', t: at + step },
        { state: 'TIME_WAIT', t: at + step * 2 },
        // Linux 的 TIME_WAIT 固定 60 秒，这里也取 60 秒
        { state: 'CLOSED', t: at + step * 2 + 60_000 },
      )
    }
  }

  private inspect(target: Target, p: Profile, t: number): Inspection {
    const pick = <T,>(xs: T[]) => xs[Math.floor(this.rand() * xs.length)]
    switch (target.l7) {
      case 'TLS':
        return {
          identifiedBy: 'TLS ClientHello 记录头（0x16 0x03）+ SNI 扩展',
          fields: [
            ['SNI', target.host],
            ['版本', pick(['TLS 1.3', 'TLS 1.3', 'TLS 1.2'])],
            ['ALPN', pick(['h2', 'h2', 'http/1.1'])],
            ['密码套件', pick(['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256'])],
          ],
        }
      case 'QUIC':
        return {
          identifiedBy: 'QUIC Initial 长包头（UDP 443，版本 0x00000001）',
          fields: [
            ['SNI', target.host],
            ['版本', 'QUIC v1'],
            ['ALPN', 'h3'],
          ],
        }
      case 'DNS': {
        const qtype = pick(['A', 'AAAA', 'HTTPS'])
        return {
          identifiedBy: 'UDP 53 + DNS 报文头校验',
          fields: [
            ['查询', target.host],
            ['类型', qtype],
            ['响应码', 'NOERROR'],
            ['应答', qtype === 'AAAA' ? '2001:db8::1a' : '203.0.113.10'],
            ['TTL', `${60 + Math.floor(this.rand() * 240)} s`],
          ],
        }
      }
      case 'HTTP': {
        const paths = ['/', '/src/main.tsx', '/src/App.tsx', '/@vite/client', '/node_modules/.vite/deps/react.js', '/api/health']
        const requests = Array.from({ length: 3 + Math.floor(this.rand() * 4) }, (_, i) => ({
          t: t + i * 180,
          method: i % 5 === 4 ? 'POST' : 'GET',
          path: pick(paths),
          status: pick([200, 200, 200, 304, 304, 404]),
          ms: Math.round(2 + this.rand() * 38),
        }))
        return {
          identifiedBy: 'HTTP/1.1 明文请求行',
          fields: [
            ['Host', `localhost:${target.localPort ?? target.port}`],
            ['版本', 'HTTP/1.1'],
            ['User-Agent', p.name === 'chrome.exe' ? 'Chrome/130.0' : 'vite-dev-server'],
          ],
          requests,
        }
      }
      case 'SSH':
        return { identifiedBy: 'SSH 协议版本交换串', fields: [['客户端', 'SSH-2.0-OpenSSH_9.6'], ['服务端', 'SSH-2.0-OpenSSH_9.2p1'], ['加密', 'chacha20-poly1305@openssh.com']] }
      case 'PostgreSQL':
        return { identifiedBy: 'PostgreSQL StartupMessage（协议 3.0）', fields: [['用户', 'app_dev'], ['数据库', 'observatory_dev'], ['SSL', '否（本机回环）']] }
      default:
        return { identifiedBy: '未匹配到已知特征', fields: [] }
    }
  }

  tick(t: number): Frame {
    for (const p of PROFILES) {
      for (const target of p.targets) {
        if (this.rand() < target.spawn) this.spawn(p, target, t)
      }
    }
    const events = this.pendingEvents
    this.pendingEvents = []

    for (const c of this.conns.values()) {
      while (c.plan.length && c.plan[0].t <= t) {
        const step = c.plan.shift()!
        events.push({ t: step.t, connId: c.id, procName: c.procName, host: c.host, from: c.state, to: step.state, failure: step.failure })
        c.state = step.state
        c.transitions = [...c.transitions, { state: step.state, t: step.t }]
        if (step.failure) c.failure = step.failure
        if (step.state === 'CLOSED') c.endedAt = step.t
      }
      if (ACTIVE.includes(c.state)) {
        // 突发流量：大多数时间平稳，偶尔冲高
        c.burst = c.burst > 0 ? c.burst - 1 : this.rand() < 0.04 ? 3 + Math.floor(this.rand() * 5) : 0
        const gain = (c.burst > 0 ? 2.4 : 0.7) * (0.55 + this.rand() * 0.9)
        c.rxRate = c.base.rx * gain
        c.txRate = c.base.tx * gain * (0.7 + this.rand() * 0.6)
        c.rxBytes += c.rxRate
        c.txBytes += c.txRate
        c.rttMs = Math.max(0.05, c.rttMs * (0.92 + this.rand() * 0.16))
        if (c.lossy && this.rand() < 0.35) c.retrans += 1 + Math.floor(this.rand() * 3)
        else if (c.l4 === 'TCP' && c.rttMs > 1 && this.rand() < 0.01) c.retrans += 1
      } else {
        c.rxRate = 0
        c.txRate = 0
      }
      if (c.endedAt && t - c.endedAt > RETAIN_CLOSED_MS) this.conns.delete(c.id)
    }

    return {
      t,
      procs: this.procs,
      capture: this.capture,
      events,
      // 只拷必要字段；plan/base 等内部字段不会被界面读取
      conns: [...this.conns.values()].map((c) => ({ ...c })),
    }
  }
}
