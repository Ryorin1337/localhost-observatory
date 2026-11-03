import { useMemo } from 'react'
import { formatBytes, formatClock, formatRate } from '../lib/format'
import type { RatePoint } from '../lib/store'
import { useColors } from '../lib/theme'
import { EChart, echarts, tooltipStyle } from './EChart'

export function ThroughputLegend({ series }: { series: RatePoint[] }) {
  const last = series[series.length - 1]
  return (
    <div className="data flex gap-3 text-[11px] text-fg-2">
      <span className="flex items-center gap-1.5"><i className="h-0.5 w-3 rounded-full" style={{ background: 'var(--down)' }} />下载 {formatRate(last?.rx ?? 0)}</span>
      <span className="flex items-center gap-1.5"><i className="h-0.5 w-3 rounded-full" style={{ background: 'var(--up)' }} />上传 {formatRate(last?.tx ?? 0)}</span>
    </div>
  )
}

/** 下载朝上、上传朝下，共用一条零基线和同一个量程 */
export function ThroughputChart({ series, compact = false }: { series: RatePoint[]; compact?: boolean }) {
  const c = useColors()
  const option = useMemo(() => {
    const area = (color: string, up: boolean) =>
      new echarts.graphic.LinearGradient(0, up ? 0 : 1, 0, up ? 1 : 0, [
        { offset: 0, color: color + '40' },
        { offset: 1, color: color + '05' },
      ])
    const down = c('--down')
    const up = c('--up')
    return {
      animation: false,
      grid: { left: compact ? 58 : 68, right: 14, top: 8, bottom: 24 },
      xAxis: {
        type: 'time',
        min: series[0]?.t,
        max: series[series.length - 1]?.t,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: c('--fg-3'),
          fontSize: 10,
          fontFamily: c('--font-data'),
          hideOverlap: true,
          formatter: (v: number) => formatClock(v),
        },
      },
      yAxis: {
        type: 'value',
        splitNumber: 4,
        // 没有流量时轴也要有可读的刻度，而不是一排 0 B
        minInterval: 1024,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: c('--line'), width: 1 } },
        axisLabel: {
          color: c('--fg-3'),
          fontSize: 10,
          fontFamily: c('--font-data'),
          formatter: (v: number) => (v === 0 ? '0' : formatBytes(Math.abs(v))),
        },
      },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(c),
        axisPointer: { type: 'line', lineStyle: { color: c('--line-strong'), width: 1 } },
        formatter: (ps: { axisValue: number; seriesIndex: number; value: [number, number] }[]) => {
          const row = (label: string, color: string, v: number) =>
            `<div style="display:flex;gap:16px;justify-content:space-between"><span><span style="color:${color}">—</span> ${label}</span><b style="font-family:${c('--font-data')};font-weight:500">${formatRate(Math.abs(v))}</b></div>`
          return `<div style="color:${c('--fg-3')};margin-bottom:2px">${formatClock(ps[0].axisValue)}</div>${row('下载', down, ps[0].value[1])}${row('上传', up, ps[1].value[1])}`
        },
      },
      series: [
        {
          id: 'rx',
          name: '下载',
          type: 'line',
          showSymbol: false,
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { width: 2, color: down },
          itemStyle: { color: down, borderColor: c('--panel'), borderWidth: 2 },
          areaStyle: { color: area(down, true) },
          data: series.map((p) => [p.t, p.rx]),
        },
        {
          id: 'tx',
          name: '上传',
          type: 'line',
          showSymbol: false,
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { width: 2, color: up },
          itemStyle: { color: up, borderColor: c('--panel'), borderWidth: 2 },
          areaStyle: { color: area(up, false) },
          data: series.map((p) => [p.t, -p.tx]),
        },
      ],
    }
  }, [series, c, compact])

  return <EChart option={option} label="下载与上传速率随时间变化的曲线，下载在零线上方，上传在零线下方" />
}
