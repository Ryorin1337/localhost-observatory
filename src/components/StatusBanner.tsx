import { useState } from 'react'
import type { Snapshot } from '../lib/store'
import { inTauri, relaunchElevated } from '../lib/tauriSource'

function RelaunchButton() {
  const [message, setMessage] = useState<string | null>(null)
  return (
    <span className="ml-2 inline-flex items-center gap-2">
      <button
        onClick={() => {
          setMessage(null)
          // 成功时应用会直接退出并在新窗口里重启，只有失败或取消才会走到这里
          relaunchElevated().catch((e) => setMessage(String(e) === '已取消' ? '已取消，仍是受限模式。' : String(e)))
        }}
        className="rounded-[3px] border border-accent bg-wash px-2 py-[2px] text-[12px] font-medium text-fg hover:bg-raise"
      >
        以管理员身份重新启动
      </button>
      {message && <span className="text-[12px] text-fg-2">{message}</span>}
    </span>
  )
}

/** 数据不完整时直接说明原因和解决办法，不让人误以为“速率是 0”是真实情况 */
export function StatusBanner({ snap }: { snap: Snapshot }) {
  if (snap.simulated) return null

  let glyph = '▲'
  let color = 'var(--serious)'
  let text: React.ReactNode = null
  const who = inTauri ? '应用' : '后端'

  if (snap.status === 'disconnected') {
    glyph = '✕'
    color = 'var(--critical)'
    text = inTauri
      ? '和采集模块的连接断开了，请重新打开应用。'
      : snap.conns.length > 0
        ? '后端连接已断开，下面是断开前的数据。正在自动重连。'
        : <>连不上后端。运行 <code className="data">target\release\observatory.exe</code> 后这里会自动恢复。</>
  } else if (snap.capture && !snap.capture.elevated) {
    text = (
      <>
        受限模式：{who}不是以管理员身份运行的。连接、TCP 状态和进程树是真实的，但速率、RTT、域名和协议内容拿不到，显示为空或按端口推断。
        {inTauri ? <RelaunchButton /> : '从管理员终端启动后端可获得完整数据。'}
      </>
    )
  } else if (snap.capture && (!snap.capture.rates || !snap.capture.payload)) {
    const missing = [!snap.capture.rates && '速率和域名（ETW）', !snap.capture.payload && '协议内容（抓包）'].filter(Boolean).join('、')
    const reasons = snap.capture.errors ?? []
    text = `部分采集没有启动：${missing}。${reasons.length ? reasons.join('；') : inTauri ? '' : '原因见后端终端的输出。'}`
  }

  if (!text) return null
  return (
    <div role="status" className="rounded-[3px] border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg">
      <span aria-hidden="true" className="mr-1.5" style={{ color }}>{glyph}</span>
      {text}
    </div>
  )
}
