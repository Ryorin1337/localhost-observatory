import type { DataSource, Frame, Hello, SourceHandlers } from './types'

const RETRY_MS = 2000

type Message = (Frame & { type: 'frame' }) | (Hello & { type: 'hello' })

/** 连接 Rust 后端。页面和后端同源；开发时由 Vite 代理 /ws */
export class WsSource implements DataSource {
  label = 'Windows ETW'
  simulated = false

  start(handlers: SourceHandlers) {
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const connect = () => {
      handlers.onStatus('connecting')
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${scheme}//${location.host}/ws`)
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as Message
        if (msg.type === 'hello') {
          handlers.onHello(msg)
          handlers.onStatus('live')
        } else {
          handlers.onFrame(msg)
        }
      }
      socket.onclose = () => {
        if (stopped) return
        handlers.onStatus('disconnected')
        retry = setTimeout(connect, RETRY_MS)
      }
    }
    connect()

    return () => {
      stopped = true
      clearTimeout(retry)
      socket?.close()
    }
  }
}
