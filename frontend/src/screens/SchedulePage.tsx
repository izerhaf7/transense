import { useEffect, useMemo, useState } from 'react'

import { apiBaseUrl } from '../api'
import { ArrowBackIcon, ArrowRightIcon, ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchIcon } from '../icons'

interface GtfsRouteInfo {
  id: string
  name: string
  long_name: string
  color: string
}

interface GtfsRouteStop {
  id: string
  name: string
}

interface ScheduleStopGroup {
  route_code: string
  color: string
  headsign: string
  direction: string
  platform?: string
  times: string[]
}

interface ScheduleLiveEntry {
  bus_id: string
  route_code: string
  eta_minutes: number
  headsign: string
}

interface ScheduleDetailData {
  stop: { id: string; name: string; operator?: string; wheelchair_boarding?: string }
  timetable: ScheduleStopGroup[]
  live: ScheduleLiveEntry[]
}

interface RailLineInfo {
  operator: string
  operator_name: string
  code: string
  name: string
  color: string
  mode: string
  mode_label: string
}

interface RailStopInfo {
  id: string
  code: string
  name: string
}

export function SchedulePage() {
  const [mode, setMode] = useState<'bus' | 'rail'>('bus')
  const [routes, setRoutes] = useState<GtfsRouteInfo[]>([])
  const [railLines, setRailLines] = useState<RailLineInfo[]>([])
  const [query, setQuery] = useState('')
  const [expandedRoute, setExpandedRoute] = useState<string | null>(null)
  const [routeStops, setRouteStops] = useState<Record<string, GtfsRouteStop[]>>({})
  const [loadingStops, setLoadingStops] = useState(false)
  const [selectedStop, setSelectedStop] = useState<{ id: string; name: string } | null>(null)
  const [schedule, setSchedule] = useState<ScheduleDetailData | null>(null)
  const [loadingSchedule, setLoadingSchedule] = useState(false)
  const [searchStops, setSearchStops] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/gtfs/routes`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { routes: { id: string; name: string; long_name: string; color: string }[] }
        setRoutes(data.routes)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/transit/lines`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { lines: RailLineInfo[] }
        setRailLines(data.lines)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchStops([])
      return
    }
    if (mode !== 'bus') return
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/gtfs/stops/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { stops: { id: string; name: string }[] }
        if (!controller.signal.aborted) setSearchStops(data.stops)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [query, mode])

  const toggleRoute = async (routeId: string) => {
    if (expandedRoute === routeId) {
      setExpandedRoute(null)
      return
    }
    setExpandedRoute(routeId)
    if (routeStops[routeId]) return
    setLoadingStops(true)
    try {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(routeId)}/stops`)
      if (!res.ok) return
      const data = await res.json() as { stops: GtfsRouteStop[] }
      setRouteStops((prev) => ({ ...prev, [routeId]: data.stops }))
    } catch { /* skip */ } finally {
      setLoadingStops(false)
    }
  }

  const toggleRailLine = async (key: string) => {
    if (expandedRoute === key) {
      setExpandedRoute(null)
      return
    }
    setExpandedRoute(key)
    if (routeStops[key]) return
    setLoadingStops(true)
    try {
      const [operator, code] = key.split(':')
      const res = await fetch(`${apiBaseUrl}/api/transit/line/${encodeURIComponent(operator)}/${encodeURIComponent(code)}/stations`)
      if (!res.ok) return
      const data = await res.json() as { stations: RailStopInfo[] }
      const stops: GtfsRouteStop[] = data.stations.map((s) => ({ id: s.id, name: s.name }))
      setRouteStops((prev) => ({ ...prev, [key]: stops }))
    } catch { /* skip */ } finally {
      setLoadingStops(false)
    }
  }

  const openBusStopSchedule = async (stopId: string, stopName: string) => {
    setSelectedStop({ id: stopId, name: stopName })
    setSchedule(null)
    setLoadingSchedule(true)
    try {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/stop/${encodeURIComponent(stopId)}/schedule`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { stop: { id: string; name: string; wheelchair_boarding?: string }; timetable: ScheduleStopGroup[]; live: ScheduleLiveEntry[] }
      setSchedule(data)
    } catch (error) {
      console.warn('Stop schedule fetch failed.', error)
    } finally {
      setLoadingSchedule(false)
    }
  }

  const openRailStopSchedule = async (stationId: string, stationName: string) => {
    setSelectedStop({ id: stationId, name: stationName })
    setSchedule(null)
    setLoadingSchedule(true)
    try {
      const [operator, code] = stationId.split('-')
      const res = await fetch(`${apiBaseUrl}/api/transit/stop/${encodeURIComponent(operator)}/${encodeURIComponent(code)}/schedule`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { stop: { id: string; name: string; operator: string }; timetable: ScheduleStopGroup[] }
      setSchedule({ stop: data.stop, timetable: data.timetable, live: [] })
    } catch (error) {
      console.warn('Rail schedule fetch failed.', error)
    } finally {
      setLoadingSchedule(false)
    }
  }

  const filteredRoutes = useMemo(() => {
    const trimmed = query.trim().toLocaleLowerCase('id-ID')
    if (!trimmed) return routes
    return routes.filter((r) =>
      r.name.toLocaleLowerCase('id-ID').includes(trimmed)
      || r.long_name.toLocaleLowerCase('id-ID').includes(trimmed)
      || r.id.toLocaleLowerCase('id-ID').includes(trimmed)
    )
  }, [routes, query])

  const filteredRailLines = useMemo(() => {
    const trimmed = query.trim().toLocaleLowerCase('id-ID')
    if (!trimmed) return railLines
    return railLines.filter((l) =>
      l.name.toLocaleLowerCase('id-ID').includes(trimmed)
      || l.code.toLocaleLowerCase('id-ID').includes(trimmed)
      || l.mode_label.toLocaleLowerCase('id-ID').includes(trimmed)
    )
  }, [railLines, query])

  const isSearching = query.trim().length > 0

  const detailView = (
    <section className="schedule-detail" aria-label={`Jadwal halte ${selectedStop?.name}`}>
      <div className="schedule-detail__header">
        <button type="button" className="schedule-detail__back" onClick={() => setSelectedStop(null)}><ArrowBackIcon size={18} /> Kembali</button>
        <button type="button" className="schedule-detail__close" onClick={() => setSelectedStop(null)} aria-label="Tutup jadwal"><CloseIcon size={18} /></button>
      </div>
      <div>
        <p className="eyebrow">JADWAL KEDATANGAN</p>
        <h3>{selectedStop?.name}</h3>
      </div>
      {loadingSchedule ? <p className="schedule-routes__loading">Memuat jadwalâ€¦</p> : null}
      {schedule && schedule.live.length > 0 ? (
        <div className="schedule-detail__live">
          <p className="eyebrow">LIVE â€” BUS MENDEKAT</p>
          {schedule.live.map((bus) => (
            <div className="schedule-detail__live-row" key={`${bus.bus_id}-${bus.route_code}`}>
              <span className="schedule-route__badge" style={{ background: schedule.timetable.find((g) => g.route_code === bus.route_code)?.color ?? 'var(--brand-color-accent)' }}>{bus.route_code}</span>
              <span className="schedule-detail__live-eta">{bus.eta_minutes} menit</span>
              <span className="schedule-detail__live-headsign">{bus.headsign}</span>
            </div>
          ))}
        </div>
      ) : null}
      {schedule && schedule.timetable.length > 0 ? (
        <div className="schedule-detail__timetable">
          <p className="eyebrow">JADWAL PER RUTE</p>
          {schedule.timetable.map((group, index) => (
            <div className="schedule-detail__group" key={`${group.route_code}-${group.headsign}-${index}`}>
              <div className="schedule-detail__group-head">
                <span className="schedule-route__badge" style={{ background: group.color }}>{group.route_code}</span>
                <span className="schedule-detail__group-headsign">{group.headsign}</span>
                {group.platform ? <span className="schedule-detail__platform">Peron {group.platform}</span> : null}
              </div>
              <div className="schedule-detail__times">
                {group.times.map((time) => <span className="schedule-detail__time" key={time}>{time}</span>)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {schedule && schedule.timetable.length === 0 && schedule.live.length === 0 && !loadingSchedule ? (
        <p className="schedule-routes__loading">Tidak ada jadwal untuk halte ini.</p>
      ) : null}
    </section>
  )

  if (selectedStop) {
    return (
      <main className="page-content inner-page">
        {detailView}
      </main>
    )
  }

  const railList = (
    <section className="schedule-routes" aria-label="Daftar lin MRT">
      {filteredRailLines.map((line) => {
        const key = `${line.operator}:${line.code}`
        const expanded = expandedRoute === key
        const stops = routeStops[key]
        return (
          <div className="schedule-route" key={key}>
            <button
              type="button"
              className="schedule-route__head"
              aria-expanded={expanded}
              onClick={() => { void toggleRailLine(key) }}
            >
              <span className="schedule-route__badge" style={{ background: line.color }}>{line.code}</span>
              <span className="schedule-route__name">{line.name}</span>
              <span className="schedule-result-tag schedule-result-tag--rail">{line.mode_label || 'MRT'}</span>
              <span className="schedule-route__toggle" aria-hidden="true">{expanded ? <ChevronUpIcon size={20} /> : <ChevronDownIcon size={20} />}</span>
            </button>
            {expanded ? (
              <div className="schedule-route__stops">
                {stops ? stops.map((stop) => (
                  <button
                    key={stop.id}
                    type="button"
                    className="schedule-stop-row"
                    onClick={() => { void openRailStopSchedule(stop.id, stop.name) }}
                  >
                    <span className="schedule-stop-row__name">{stop.name}</span>
                    <span className="schedule-stop-row__cta">Jadwal <ArrowRightIcon size={16} /></span>
                  </button>
                )) : loadingStops ? <p className="schedule-routes__loading">Memuat stasiun…</p> : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </section>
  )

  const busList = (
    <section className="schedule-routes" aria-label="Daftar trayek">
      {(isSearching ? filteredRoutes : routes).map((route) => {
        const expanded = expandedRoute === route.id
        const stops = routeStops[route.id]
        return (
          <div className="schedule-route" key={route.id}>
            <button
              type="button"
              className="schedule-route__head"
              aria-expanded={expanded}
              onClick={() => { void toggleRoute(route.id) }}
            >
              <span className="schedule-route__badge" style={{ background: route.color }}>{route.name}</span>
              <span className="schedule-route__name">{route.long_name}</span>
              <span className="schedule-route__toggle" aria-hidden="true">{expanded ? <ChevronUpIcon size={20} /> : <ChevronDownIcon size={20} />}</span>
            </button>
            {expanded ? (
              <div className="schedule-route__stops">
                {stops ? stops.map((stop) => (
                  <button
                    key={stop.id}
                    type="button"
                    className="schedule-stop-row"
                    onClick={() => { void openBusStopSchedule(stop.id, stop.name) }}
                  >
                    <span className="schedule-stop-row__name">{stop.name}</span>
                    <span className="schedule-stop-row__cta">Jadwal <ArrowRightIcon size={16} /></span>
                  </button>
                )) : loadingStops ? <p className="schedule-routes__loading">Memuat halteâ€¦</p> : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </section>
  )

  const searchResults = (
    <section className="schedule-search-results" aria-label="Hasil pencarian">
      <p className="eyebrow">HASIL PENCARIAN</p>
      {mode === 'bus' ? (
        <>
          {filteredRoutes.map((route) => {
            const expanded = expandedRoute === route.id
            const stops = routeStops[route.id]
            return (
              <div className="schedule-route" key={`route-${route.id}`}>
                <button
                  type="button"
                  className="schedule-route__head"
                  aria-expanded={expanded}
                  onClick={() => { void toggleRoute(route.id) }}
                >
                  <span className="schedule-route__badge" style={{ background: route.color }}>{route.name}</span>
                  <span className="schedule-route__name">{route.long_name}</span>
                  <span className="schedule-result-tag schedule-result-tag--route">TRAYEK</span>
                  <span className="schedule-route__toggle" aria-hidden="true">{expanded ? <ChevronUpIcon size={20} /> : <ChevronDownIcon size={20} />}</span>
                </button>
                {expanded ? (
                  <div className="schedule-route__stops">
                    {stops ? stops.map((stop) => (
                      <button
                        key={stop.id}
                        type="button"
                        className="schedule-stop-row"
                        onClick={() => { void openBusStopSchedule(stop.id, stop.name) }}
                      >
                        <span className="schedule-stop-row__name">{stop.name}</span>
                        <span className="schedule-stop-row__cta">Jadwal <ArrowRightIcon size={16} /></span>
                      </button>
                    )) : loadingStops ? <p className="schedule-routes__loading">Memuat halteâ€¦</p> : null}
                  </div>
                ) : null}
              </div>
            )
          })}
          {searchStops.map((stop) => (
            <button
              key={`stop-${stop.id}`}
              type="button"
              className="schedule-stop-row"
              onClick={() => { void openBusStopSchedule(stop.id, stop.name) }}
            >
              <span className="schedule-result-tag schedule-result-tag--stop">HALTE</span>
              <span className="schedule-stop-row__name">{stop.name}</span>
              <span className="schedule-stop-row__cta">Jadwal <ArrowRightIcon size={16} /></span>
            </button>
          ))}
          {filteredRoutes.length === 0 && searchStops.length === 0 ? <p className="schedule-routes__loading">Tidak ada halte atau trayek yang cocok.</p> : null}
        </>
      ) : (
        <>
          {filteredRailLines.map((line) => {
            const key = `${line.operator}:${line.code}`
            const expanded = expandedRoute === key
            const stops = routeStops[key]
            return (
              <div className="schedule-route" key={`rail-${key}`}>
                <button
                  type="button"
                  className="schedule-route__head"
                  aria-expanded={expanded}
                  onClick={() => { void toggleRailLine(key) }}
                >
                  <span className="schedule-route__badge" style={{ background: line.color }}>{line.code}</span>
                  <span className="schedule-route__name">{line.name}</span>
                  <span className="schedule-result-tag schedule-result-tag--rail">{line.mode_label || 'MRT'}</span>
                  <span className="schedule-route__toggle" aria-hidden="true">{expanded ? <ChevronUpIcon size={20} /> : <ChevronDownIcon size={20} />}</span>
                </button>
                {expanded ? (
                  <div className="schedule-route__stops">
                    {stops ? stops.map((stop) => (
                      <button
                        key={stop.id}
                        type="button"
                        className="schedule-stop-row"
                        onClick={() => { void openRailStopSchedule(stop.id, stop.name) }}
                      >
                        <span className="schedule-stop-row__name">{stop.name}</span>
                        <span className="schedule-stop-row__cta">Jadwal <ArrowRightIcon size={16} /></span>
                      </button>
                    )) : loadingStops ? <p className="schedule-routes__loading">Memuat stasiun…</p> : null}
                  </div>
                ) : null}
              </div>
            )
          })}
          {filteredRailLines.length === 0 ? <p className="schedule-routes__loading">Tidak ada lin MRT yang cocok.</p> : null}
        </>
      )}
    </section>
  )

  return (
    <main className="page-content inner-page">
      <section className="page-intro">
        <p className="eyebrow">JADWAL TRANSJAKARTA & MRT / GTFS + LIVE</p>
        <h2>Jadwal halte & stasiun</h2>
        <p>Pilih moda, buka rute/lin, lalu lihat jadwal kedatangan per rute plus ETA live bila tersedia.</p>
      </section>

      <div className="schedule-mode-toggle" role="tablist" aria-label="Pilih moda">
        <button
          type="button"
          className={`schedule-mode-btn${mode === 'bus' ? ' schedule-mode-btn--active' : ''}`}
          onClick={() => { setMode('bus'); setExpandedRoute(null) }}
          aria-selected={mode === 'bus'}
          role="tab"
        >
          Bus
        </button>
        <button
          type="button"
          className={`schedule-mode-btn${mode === 'rail' ? ' schedule-mode-btn--active' : ''}`}
          onClick={() => { setMode('rail'); setExpandedRoute(null) }}
          aria-selected={mode === 'rail'}
          role="tab"
        >
          MRT
        </button>
      </div>

      <section className="schedule-search" role="search">
        <label className="sr-only" htmlFor="schedule-search">{mode === 'bus' ? 'Cari halte atau trayek' : 'Cari lin MRT'}</label>
        <span className="schedule-search__icon" aria-hidden="true"><SearchIcon size={20} /></span>
        <input
          id="schedule-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={mode === 'bus' ? 'Cari halte atau trayek' : 'Cari lin MRT'}
        />
      </section>

      {isSearching ? searchResults : (mode === 'rail' ? railList : busList)}
    </main>
  )
}

