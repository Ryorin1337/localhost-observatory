// 运行：npm test（Node 内置测试运行器 + 类型剥离）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ancestry, buildForest, flatten, subtreePids } from './tree.ts'
import type { Conn, ProcInfo } from './types.ts'

const p = (pid: number, ppid: number, startedAt = 1000): ProcInfo => ({
  pid, ppid, startedAt, name: `p${pid}`, exe: '', cmd: '', memoryBytes: 0, cpuPercent: 0,
})

const conn = (pid: number, over: Partial<Conn> = {}) => ({
  pid, state: 'ESTABLISHED', direction: 'out', rxRate: 10, txRate: 1, ...over,
}) as Conn

test('按父 PID 建树并汇总子孙流量', () => {
  const roots = buildForest([p(1, 0), p(2, 1), p(3, 2)], [conn(3), conn(2, { rxRate: 5, txRate: 0 })])
  assert.equal(roots.length, 1)
  const [root] = roots
  assert.equal(root.own.conns, 0)
  assert.equal(root.total.conns, 2)
  assert.equal(root.total.rx, 15)
  assert.equal(root.children[0].children[0].proc.pid, 3)
  assert.deepEqual([...subtreePids(root)], [1, 2, 3])
  assert.deepEqual(ancestry(root.children[0].children[0]).map((n) => n.proc.pid), [1, 2, 3])
})

test('父进程已退出的成为孤儿根节点', () => {
  const [root] = buildForest([p(5, 999)], [])
  assert.equal(root.orphaned, true)
  assert.equal(root.parent, null)
})

test('PID 被复用时不认比子进程还晚启动的父进程', () => {
  const roots = buildForest([p(10, 0, 50_000), p(20, 10, 1000)], [])
  assert.equal(roots.length, 2)
  assert.equal(roots.find((n) => n.proc.pid === 20)?.orphaned, true)
})

test('上报数据成环时不会死循环，也不丢节点', () => {
  const roots = buildForest([p(1, 2), p(2, 1)], [])
  const count = roots.reduce((n, r) => n + subtreePids(r).size, 0)
  assert.equal(count, 2)
})

test('PID 0 指向自身时是普通根节点', () => {
  const [root] = buildForest([p(0, 0)], [])
  assert.equal(root.orphaned, false)
})

test('只看网络活动时保留路径上的祖先，隐藏无关分支', () => {
  const roots = buildForest([p(1, 0), p(2, 1), p(3, 1), p(4, 0)], [conn(2)])
  const rows = flatten(roots, new Set(), true)
  assert.deepEqual(rows.map((r) => r.node.proc.pid), [1, 2])
  assert.equal(rows[1].isLast, true)
  assert.equal(flatten(roots, new Set(), false).length, 4)
})

test('折叠节点隐藏子孙，竖线只在还有兄弟时画', () => {
  const roots = buildForest([p(1, 0), p(2, 1), p(3, 2), p(4, 1, 2000)], [])
  const rows = flatten(roots, new Set(), false)
  assert.deepEqual(rows.map((r) => r.node.proc.pid), [1, 2, 3, 4])
  // p3 的父 p2 后面还有兄弟 p4，所以 p3 这一行第二列要画竖线
  assert.deepEqual(rows[2].guides, [false, true])
  assert.deepEqual(flatten(roots, new Set([2]), false).map((r) => r.node.proc.pid), [1, 2, 4])
})

test('PID 0 的 TIME_WAIT 不算进程的网络活动', () => {
  const [root] = buildForest([p(0, 0)], [conn(0, { state: 'TIME_WAIT' })])
  assert.equal(root.own.conns, 0)
})

test('已关闭的连接不计入，监听单独计数', () => {
  const [root] = buildForest([p(1, 0)], [conn(1, { state: 'CLOSED' }), conn(1, { direction: 'listen', state: 'LISTEN' })])
  assert.equal(root.own.conns, 0)
  assert.equal(root.own.listens, 1)
})
