import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConnectionDrawer } from './components/ConnectionDrawer'
import { ConnectionTable } from './components/ConnectionTable'
import { EventFeed } from './components/EventFeed'
import { FilterBar } from './components/FilterBar'
import { Header, type View } from './components/Header'
import { KpiStrip } from './components/KpiStrip'
import { Panel } from './components/Panel'
import { ProcessRail } from './components/ProcessRail'
import { ProcessTreeView } from './components/ProcessTreeView'
import { SkyChart } from './components/SkyChart'
import { StateBreakdown } from './components/StateBreakdown'
import { StatusBanner } from './components/StatusBanner'
import { ThroughputChart, ThroughputLegend } from './components/ThroughputChart'
import { TimelineView } from './components/TimelineView'
import { matches, parseQuery, toggleToken, wantsClosed, type FilterKey } from './lib/filter'
import { isLive } from './lib/meta'
import { aggregate, store, useSnapshot } from './lib/store'
import { ThemeContext, useThemeState } from './lib/theme'

export function App() {
  const snap = useSnapshot()
  const { theme, toggle: toggleTheme } = useThemeState()
  const [view, setView] = useState<View>('overview')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedPid, setSelectedPid] = useState<number | null>(null)
  const [includeClosed, setIncludeClosed] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const tokens = useMemo(() => parseQuery(query), [query])
  const visible = useMemo(() => snap.conns.filter((c) => matches(c, tokens)), [snap.conns, tokens])
  const live = useMemo(() => visible.filter(isLive), [visible])
  const tableRows = includeClosed || wantsClosed(tokens) ? visible : live
  const series = useMemo(() => aggregate(visible, snap), [visible, snap])
  const selected = selectedId ? snap.connById.get(selectedId) ?? null : null

  const onFilter = useCallback((key: FilterKey, value: string) => setQuery((q) => toggleToken(q, key, value)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).tagName === 'INPUT'
      if (e.key === 'Escape') {
        if (typing) (e.target as HTMLElement).blur()
        else setSelectedId(null)
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.code === 'Space' && (e.target as HTMLElement).tagName === 'BODY') {
        e.preventDefault()
        store.setPaused(!store.get().paused)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <ThemeContext.Provider value={theme}>
      <div className="flex min-h-full flex-col gap-2 pb-3 xl:h-full xl:min-h-[780px]" style={{ paddingLeft: 'max(16px, env(safe-area-inset-left, 0px))', paddingRight: 'max(16px, env(safe-area-inset-right, 0px))' }}>
        <Header view={view} onView={setView} snap={snap} theme={theme} onToggleTheme={toggleTheme} />
        <FilterBar
          ref={searchRef}
          query={query}
          onQuery={setQuery}
          onFilter={onFilter}
          all={snap.conns}
          shown={live.length}
          includeClosed={includeClosed}
          onIncludeClosed={setIncludeClosed}
        />
        <StatusBanner snap={snap} />

        <main className="min-h-0 flex-1">
          {view === 'overview' && (
            <div className="grid h-full gap-px overflow-hidden rounded-[3px] border border-line bg-line xl:grid-cols-[264px_minmax(0,1fr)_348px] xl:grid-rows-[auto_minmax(0,1fr)_minmax(0,1.15fr)]">
              <div className="xl:row-span-3">
                <ProcessRail snap={snap} query={query} onFilter={onFilter} />
              </div>
              <div className="order-first xl:order-none xl:col-span-2">
                <KpiStrip live={live} visible={visible} series={series} ratesKnown={snap.capture?.rates ?? false} onFilter={onFilter} />
              </div>
              <Panel title="吞吐量" hint={snap.capture && !snap.capture.rates ? '需要管理员权限才能统计' : '最近 3 分钟'} right={<ThroughputLegend series={series} />} className="h-[280px] xl:h-auto">
                <ThroughputChart series={series} />
              </Panel>
              <SkyChart conns={live} onSelect={setSelectedId} />
              <Panel title="连接" hint={`${tableRows.length} 条`} className="h-[420px] xl:h-auto">
                <ConnectionTable conns={tableRows} now={snap.t} selectedId={selectedId} onSelect={setSelectedId} onFilter={onFilter} compact />
              </Panel>
              <div className="flex min-h-0 flex-col gap-px">
                <StateBreakdown conns={live} query={query} onFilter={onFilter} />
                <EventFeed events={snap.events} visibleIds={visible} onSelect={setSelectedId} />
              </div>
            </div>
          )}
          {view === 'connections' && (
            <div className="h-[75vh] overflow-hidden rounded-[3px] border border-line xl:h-full">
              <Panel title="全部连接" hint={`${tableRows.length} 条`} className="h-full">
                <ConnectionTable conns={tableRows} now={snap.t} selectedId={selectedId} onSelect={setSelectedId} onFilter={onFilter} />
              </Panel>
            </div>
          )}
          {view === 'timeline' && (
            <div className="h-[75vh] overflow-hidden rounded-[3px] border border-line xl:h-full">
              <TimelineView conns={visible} now={snap.t} onSelect={setSelectedId} />
            </div>
          )}
          {view === 'tree' && (
            <div className="overflow-hidden rounded-[3px] border border-line xl:h-full">
              <ProcessTreeView
                snap={snap}
                conns={visible}
                query={query}
                selectedPid={selectedPid}
                onSelectPid={setSelectedPid}
                onSelectConn={setSelectedId}
                onFilter={onFilter}
              />
            </div>
          )}
        </main>
      </div>

      {selected && (
        <ConnectionDrawer
          key={selected.id}
          conn={selected}
          snap={snap}
          onClose={() => setSelectedId(null)}
          onFilter={onFilter}
          onShowInTree={(pid) => {
            setSelectedPid(pid)
            setSelectedId(null)
            setView('tree')
          }}
        />
      )}
    </ThemeContext.Provider>
  )
}
