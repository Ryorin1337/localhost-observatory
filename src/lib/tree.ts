import type { Conn, ProcInfo } from './types'

export interface NetStats {
  rx: number
  tx: number
  /** 活动连接数，不含监听 */
  conns: number
  /** 监听或绑定的端口数 */
  listens: number
}

export interface TreeNode {
  proc: ProcInfo
  children: TreeNode[]
  /** 这个进程自己的网络活动 */
  own: NetStats
  /** 包含全部子孙进程 */
  total: NetStats
  parent: TreeNode | null
  /** 上报了父 PID，但父进程已退出或 PID 已被复用 */
  orphaned: boolean
}

export interface TreeRow {
  node: TreeNode
  depth: number
  /** 每一层祖先下面是否还有兄弟节点，决定这一列画不画竖线 */
  guides: boolean[]
  isLast: boolean
  hasChildren: boolean
  collapsed: boolean
}

const empty = (): NetStats => ({ rx: 0, tx: 0, conns: 0, listens: 0 })

/** sysinfo 的启动时间精度是秒，留一点余量 */
const START_SKEW_MS = 2000

export function buildForest(procs: ProcInfo[], conns: Conn[]): TreeNode[] {
  const nodes = new Map<number, TreeNode>()
  for (const proc of procs) {
    nodes.set(proc.pid, { proc, children: [], own: empty(), total: empty(), parent: null, orphaned: false })
  }

  for (const c of conns) {
    const node = nodes.get(c.pid)
    // PID 0 是所属进程已释放的 TIME_WAIT，不算 System Idle 的网络活动
    if (!node || c.pid === 0 || c.state === 'CLOSED') continue
    if (c.direction === 'listen') {
      node.own.listens += 1
    } else {
      node.own.rx += c.rxRate
      node.own.tx += c.txRate
      node.own.conns += 1
    }
  }

  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    const { pid, ppid, startedAt } = node.proc
    const parent = nodes.get(ppid)
    // Windows 不会在父进程退出后改写 ppid，PID 又会被复用：
    // 比子进程启动得还晚的“父进程”只是碰巧占了同一个 PID
    const valid = parent && ppid !== pid && parent.proc.startedAt <= startedAt + START_SKEW_MS && !createsCycle(node, parent)
    if (valid) {
      node.parent = parent
      parent.children.push(node)
    } else {
      node.orphaned = ppid !== 0 && ppid !== pid
      roots.push(node)
    }
  }

  const visit = (node: TreeNode) => {
    node.total = { ...node.own }
    for (const child of node.children) {
      visit(child)
      node.total.rx += child.total.rx
      node.total.tx += child.total.tx
      node.total.conns += child.total.conns
      node.total.listens += child.total.listens
    }
    node.children.sort(compare)
  }
  roots.forEach(visit)
  return roots.sort(compare)
}

function createsCycle(node: TreeNode, parent: TreeNode) {
  for (let at: TreeNode | null = parent; at; at = at.parent) {
    if (at === node) return true
  }
  return false
}

/** 有网络活动的排前面；同组按启动时间，每秒刷新时顺序不会跳 */
function compare(a: TreeNode, b: TreeNode) {
  const active = (n: TreeNode) => (n.total.conns + n.total.listens > 0 ? 0 : 1)
  return active(a) - active(b) || a.proc.startedAt - b.proc.startedAt || a.proc.pid - b.proc.pid
}

export function hasNetwork(node: TreeNode) {
  return node.total.conns + node.total.listens > 0
}

export function flatten(roots: TreeNode[], collapsed: ReadonlySet<number>, onlyNetwork: boolean): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: TreeNode[], depth: number, guides: boolean[]) => {
    const shown = onlyNetwork ? list.filter(hasNetwork) : list
    shown.forEach((node, i) => {
      const isLast = i === shown.length - 1
      const kids = onlyNetwork ? node.children.filter(hasNetwork) : node.children
      const isCollapsed = collapsed.has(node.proc.pid)
      rows.push({ node, depth, guides, isLast, hasChildren: kids.length > 0, collapsed: isCollapsed })
      if (!isCollapsed) walk(node.children, depth + 1, [...guides, !isLast])
    })
  }
  walk(roots, 0, [])
  return rows
}

/** 从根到这个节点的路径，用来显示祖先链 */
export function ancestry(node: TreeNode): TreeNode[] {
  const chain: TreeNode[] = []
  for (let at: TreeNode | null = node; at; at = at.parent) chain.unshift(at)
  return chain
}

export function subtreePids(node: TreeNode, into = new Set<number>()) {
  into.add(node.proc.pid)
  node.children.forEach((c) => subtreePids(c, into))
  return into
}

export function findNode(roots: TreeNode[], pid: number): TreeNode | null {
  for (const root of roots) {
    if (root.proc.pid === pid) return root
    const hit = findNode(root.children, pid)
    if (hit) return hit
  }
  return null
}

export function busiest(roots: TreeNode[]): TreeNode | null {
  let best: TreeNode | null = null
  const score = (n: TreeNode) => n.own.rx + n.own.tx + n.own.conns
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (!best || score(n) > score(best)) best = n
      walk(n.children)
    }
  }
  walk(roots)
  return best
}
