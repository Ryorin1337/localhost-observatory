import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 构建成单个 HTML，字体也内联：Rust 后端用 include_str! 嵌入二进制，离线可用。
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: { assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 4000 },
  // Tauri 开发模式要求固定端口，并且不能清屏，否则看不到 Rust 的编译输出
  clearScreen: false,
  server: {
    strictPort: true,
    // 开发时后端要带 --dev，才会放行来自 5173 端口的 Origin
    proxy: { '/ws': { target: 'ws://127.0.0.1:9470', ws: true, changeOrigin: true } },
  },
})
