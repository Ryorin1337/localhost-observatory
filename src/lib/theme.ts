import { createContext, useCallback, useContext, useMemo, useState } from 'react'

export type Theme = 'dark' | 'light'
const KEY = 'observatory.theme'

function initialTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark' || attr === 'light') return attr
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // 隐私模式下存储不可用，跟随系统即可
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

// 同步写入属性：子组件在同一轮渲染里就要读到新主题的 CSS 变量
function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // 同上
  }
  return theme
}

export function useThemeState() {
  const [theme, setTheme] = useState<Theme>(() => applyTheme(initialTheme()))
  const toggle = useCallback(() => setTheme((t) => applyTheme(t === 'dark' ? 'light' : 'dark')), [])
  return { theme, toggle }
}

export const ThemeContext = createContext<Theme>('dark')

/** Canvas 读不到 CSS 变量，这里解析成实际颜色；主题变化时返回新函数，触发图表重算 */
export function useColors() {
  const theme = useContext(ThemeContext)
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement)
    return (value: string) => {
      const m = value.match(/^var\((--[\w-]+)\)$/)
      return style.getPropertyValue(m ? m[1] : value).trim()
    }
    // theme 决定 CSS 变量的取值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])
}
