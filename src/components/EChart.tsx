import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { CustomChart, LineChart, ScatterChart } from 'echarts/charts'
import { GridComponent, PolarComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([LineChart, ScatterChart, CustomChart, GridComponent, PolarComponent, TooltipComponent, CanvasRenderer])

export { echarts }

/** 轻量封装：随容器缩放，合并式更新，这样每秒刷新时悬浮提示不会闪掉 */
export function EChart({ option, onItemClick, label }: {
  option: EChartsCoreOption
  onItemClick?: (params: { seriesIndex?: number; dataIndex: number; data: unknown }) => void
  label: string
}) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const click = useRef(onItemClick)
  click.current = onItemClick

  useEffect(() => {
    const instance = echarts.init(el.current!, undefined, { renderer: 'canvas' })
    chart.current = instance
    instance.on('click', (p) => click.current?.(p as never))
    const ro = new ResizeObserver(() => instance.resize())
    ro.observe(el.current!)
    return () => {
      ro.disconnect()
      instance.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option, { lazyUpdate: true })
  }, [option])

  return <div ref={el} role="img" aria-label={label} className="absolute inset-0" />
}

export function tooltipStyle(c: (v: string) => string) {
  return {
    backgroundColor: c('--raise'),
    borderColor: c('--line-strong'),
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: c('--fg'), fontSize: 12, fontFamily: c('--font-ui') },
    extraCssText: 'box-shadow:none;border-radius:3px;',
    confine: true,
  }
}
