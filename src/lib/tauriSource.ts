import { Channel, invoke } from '@tauri-apps/api/core'
import type { DataSource, Frame, Hello, SourceHandlers } from './types'

/** 运行在 Tauri 窗口里，而不是普通浏览器 */
export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 数据走应用内部的 IPC 通道，不经过任何本地端口 */
export class TauriSource implements DataSource {
  label = 'Windows ETW'
  simulated = false

  start(handlers: SourceHandlers) {
    let stopped = false
    handlers.onStatus('connecting')

    const channel = new Channel<Frame>()
    channel.onmessage = (frame) => {
      if (!stopped) handlers.onFrame(frame)
    }
    invoke<Hello>('subscribe', { onFrame: channel })
      .then((hello) => {
        if (stopped) return
        handlers.onHello(hello)
        handlers.onStatus('live')
      })
      .catch(() => handlers.onStatus('disconnected'))

    return () => {
      stopped = true
    }
  }
}

/** 以管理员身份重启应用。用户在系统弹窗里取消时抛出错误，应用保持运行 */
export function relaunchElevated(): Promise<void> {
  return invoke('relaunch_elevated')
}
