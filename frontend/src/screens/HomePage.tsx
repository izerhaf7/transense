import { useEffect, useMemo, useRef, useState } from 'react'

import MapboxMap, { type RailStationPopupData, type StopPopupData } from '../MapboxMap'
import { apiBaseUrl } from '../api'
import { AccessibilityIcon, AntarAkuIcon, BellIcon, CameraIcon, DelaysIcon, TranscribeIcon } from '../icons'
import { SEEDED_TRANSIT_STATE } from '../journey'
import type { Stop, TransitState } from '../journey'
import type { ProfileType } from '../profile'
import type { NotificationRecord, Screen } from '../types'
import { ArrivalsSheet } from '../components/ArrivalsSheet'
import { SearchEntry } from '../components/SearchEntry'

export function HomePage({
  displayName,
  transitState,
  notificationCount,
  notifications,
  onNavigate,
  onDismissNotification,
  profile,
}: {
  displayName: string
  transitState: TransitState | null
  notificationCount: number
  notifications: NotificationRecord[]
  onNavigate: (screen: Exclude<Screen, 'placeholder'>) => void
  onDismissNotification: (notificationId: string) => void
  profile: ProfileType
}) {
  const [gtfsStops, setGtfsStops] = useState<Stop[]>(() => transitState?.stops ?? SEEDED_TRANSIT_STATE.stops)
  const [routeShapes, setRouteShapes] = useState<{ id: string; name: string; color: string; coordinates: [number, number][] }[]>([])
  const [allRoutes, setAllRoutes] = useState<{ id: string; name: string; color: string; stop_ids: string[] }[]>([])
  const [routeStopIds, setRouteStopIds] = useState<Record<string, string[]>>({})
  const [selectedRoutes, setSelectedRoutes] = useState<Set<string>>(new Set())
  const [showFilter, setShowFilter] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [mapMode, setMapMode] = useState<'bus' | 'rail'>('bus')
  const [selectedRailKeys, setSelectedRailKeys] = useState<Set<string>>(new Set())
  const [stopInfo, setStopInfo] = useState<StopPopupData | null>(null)
  const [railLines, setRailLines] = useState<{ operator: string; code: string; name: string; color: string; mode_label: string; segments: [number, number][][] }[]>([])
  const [railStations, setRailStations] = useState<{ id: string; operator: string; code: string; name: string; lat: number; lng: number; lines: string[] }[]>([])
  const [railStationPopup, setRailStationPopup] = useState<RailStationPopupData | null>(null)
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState<string | null>(null)

  // Home content sheet: minimized by default (search only, map dominant). The
  // handle strip toggles it between minimized and a maximized overlay;
  // scrolling inside the sheet only browses content, never resizes it.
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const sheetRef = useRef<HTMLElement | null>(null)

  // The sheet is absolute inside .home-page, which ALSO contains the top bar,
  // so a percentage height would swallow the top bar when maximized. Measure
  // the area below the top bar in px and expose it as --home-sheet-max
  // (re-measured on resize/rotation, since the top bar height can change).
  useEffect(() => {
    const recomputeSheetMaxHeight = () => {
      const sheet = sheetRef.current
      if (!sheet) return
      const container = sheet.parentElement
      if (!container) return
      const containerBottom = container.getBoundingClientRect().bottom
      const topbar = container.querySelector('.home-topbar')
      const topbarBottom = topbar
        ? topbar.getBoundingClientRect().bottom
        : container.getBoundingClientRect().top
      const maxPx = Math.max(120, containerBottom - topbarBottom - 8)
      sheet.style.setProperty('--home-sheet-max', `${maxPx}px`)
    }
    recomputeSheetMaxHeight()
    window.addEventListener('resize', recomputeSheetMaxHeight)
    return () => window.removeEventListener('resize', recomputeSheetMaxHeight)
  }, [])

  // The locate button floats bottom-right inside the map shell. The minimized
  // content sheet (z-index 10) overlays the map's bottom edge, so measure the
  // sheet's top and park the button just above it (fallback 40px in CSS);
  // when the sheet is maximized it covers the button by design.
  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return
    const container = sheet.parentElement
    if (!container) return
    const hero = container.querySelector<HTMLElement>('.home-hero')
    if (!hero) return

    const recomputeLocateOffset = () => {
      const heroBottom = hero.getBoundingClientRect().bottom
      const sheetTop = sheet.getBoundingClientRect().top
      hero.style.setProperty('--home-locate-offset', `${Math.max(56, heroBottom - sheetTop + 12)}px`)
    }

    recomputeLocateOffset()
    let frame = 0
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        window.cancelAnimationFrame(frame)
        frame = window.requestAnimationFrame(recomputeLocateOffset)
      })
      resizeObserver.observe(sheet)
    }
    window.addEventListener('resize', recomputeLocateOffset)
    return () => {
      window.cancelAnimationFrame(frame)
      if (resizeObserver) resizeObserver.disconnect()
      window.removeEventListener('resize', recomputeLocateOffset)
    }
  }, [])

  // Rail geometry is refetched on mount AND whenever the user switches to rail
  // mode. The backend may have been restarted/deployed with a stitched polyline
  // since the page opened; drawing the OLD cached geometry while polling NEW
  // positions makes trains appear to float off the route (and shift on zoom).
  useEffect(() => {
    if (mapMode !== 'rail') return
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/transit/lines/geometry`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { lines: { operator: string; code: string; name: string; color: string; mode_label: string; segments: [number, number][][] }[] }
        setRailLines(data.lines)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [mapMode])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/transit/stations`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { stations: { id: string; operator: string; code: string; name: string; lat: number; lng: number; lines: string[] }[] }
        setRailStations(data.stations)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/gtfs/routes`, { signal: controller.signal })
        if (!res.ok) return
        const data = await res.json() as { routes: { id: string; name: string; color: string; stop_ids: string[] }[] }
        setAllRoutes(data.routes)
      } catch {
        // Abort on unmount is expected; other failures keep the seed routes.
      }
    }
    void load()
    return () => controller.abort()
  }, [])

  const [busPositions, setBusPositions] = useState<{ id: string; route_code: string; lat: number; lng: number; observed_at: string; next_stop?: { name: string } }[]>([])
  const [busSource, setBusSource] = useState<'realtime' | 'unavailable'>('unavailable')

  useEffect(() => {
    const fetchBuses = () => {
      fetch(`${apiBaseUrl}/api/buses`)
        .then(async (res) => {
          if (!res.ok) return
          const data = await res.json() as { source?: string; buses: { id: string; route_code: string; lat: number; lng: number; observed_at: string; next_stop?: { name: string } }[] }
          if (data.source === 'realtime') {
            setBusPositions(data.buses)
            setBusSource('realtime')
          } else {
            setBusPositions([])
            setBusSource('unavailable')
          }
        })
        .catch(() => {
          setBusPositions([])
          setBusSource('unavailable')
        })
    }
    fetchBuses()
    const interval = window.setInterval(fetchBuses, 15_000)
    return () => window.clearInterval(interval)
  }, [])

  const toggleRoute = async (routeName: string) => {
    const route = allRoutes.find((r) => r.name === routeName)
    const willSelect = !selectedRoutes.has(routeName)
    setSelectedRoutes((prev) => {
      const next = new Set(prev)
      if (next.has(routeName)) next.delete(routeName)
      else next.add(routeName)
      return next
    })
    if (willSelect && route) {
      // Lazy-load the route's shape + station stops only once it's checked.
      if (!routeShapes.some((s) => s.name === route.name)) {
        try {
          const shapeRes = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(route.id)}/shape`)
          if (shapeRes.ok) {
            const shapeData = await shapeRes.json() as { coordinates: [number, number][]; lines?: [number, number][][] }
            const lines = shapeData.lines?.length ? shapeData.lines : (shapeData.coordinates.length ? [shapeData.coordinates] : [])
            const newShapes = lines.filter((coords) => coords.length >= 2).map((coords, i) => ({ id: `${route.id}#${i}`, name: route.name, color: route.color, coordinates: coords }))
            setRouteShapes((prev) => [...prev, ...newShapes])
          }
        } catch { /* skip */ }
      }
      if (!routeStopIds[route.name]) {
        try {
          const stopsRes = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(route.id)}/stops`)
          if (stopsRes.ok) {
            const stopsData = await stopsRes.json() as { stops: { id: string; name: string; lat: number; lng: number }[] }
            const ids = stopsData.stops.map((s) => s.id)
            setRouteStopIds((prev) => ({ ...prev, [route.name]: ids }))
            setGtfsStops((prev) => {
              const seen = new Set(prev.map((s) => s.id))
              const additions = stopsData.stops.filter((s) => !seen.has(s.id)).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }))
              return [...prev, ...additions]
            })
          }
        } catch { /* skip */ }
      }
    }
  }

  const toggleAll = () => {
    if (selectedRoutes.size === allRoutes.length) {
      setSelectedRoutes(new Set())
    } else {
      setSelectedRoutes(new Set(allRoutes.map((r) => r.name)))
      // Lazy-load shapes + stops for all routes when "select all" is tapped.
      void Promise.all(allRoutes.map((route) => {
        return (async () => {
          try {
            const shapeRes = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(route.id)}/shape`)
            if (shapeRes.ok) {
              const shapeData = await shapeRes.json() as { coordinates: [number, number][]; lines?: [number, number][][] }
              const lines = shapeData.lines?.length ? shapeData.lines : (shapeData.coordinates.length ? [shapeData.coordinates] : [])
              const newShapes = lines.filter((coords) => coords.length >= 2).map((coords, i) => ({ id: `${route.id}#${i}`, name: route.name, color: route.color, coordinates: coords }))
              setRouteShapes((prev) => {
                const seen = new Set(prev.map((s) => s.id))
                return [...prev, ...newShapes.filter((s) => !seen.has(s.id))]
              })
            }
          } catch { /* skip */ }
          try {
            const stopsRes = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(route.id)}/stops`)
            if (stopsRes.ok) {
              const stopsData = await stopsRes.json() as { stops: { id: string; name: string; lat: number; lng: number }[] }
              const ids = stopsData.stops.map((s) => s.id)
              setRouteStopIds((prev) => ({ ...prev, [route.name]: ids }))
              setGtfsStops((prev) => {
                const seen = new Set(prev.map((s) => s.id))
                const additions = stopsData.stops.filter((s) => !seen.has(s.id)).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }))
                return [...prev, ...additions]
              })
            }
          } catch { /* skip */ }
        })()
      }))
    }
  }

  // MRT schedule-based trains are intentionally separate from bus realtime.
  const [railVehicles, setRailVehicles] = useState<{ id: string; trip_id: string; lat: number; lng: number; bearing: number; status: string; route_code?: string; operator?: string; line_code?: string; distance_m?: number; route_distance_m?: number }[]>([])

  // The default map has no displayed route, so it must not show every realtime bus.
  // Once routes are selected, shapes and vehicle markers follow that selection.
  const filteredShapes = selectedRoutes.size === 0
    ? []
    : selectedRoutes.size === allRoutes.length
      ? routeShapes
      : routeShapes.filter((s) => selectedRoutes.has(s.name))
  // TJ realtime route_code uses the same short route codes as GTFS for matched
  // routes (e.g. "1", "6A"); never render vehicles for hidden/unselected routes.
  const filteredBuses = selectedRoutes.size === 0
    ? []
    : selectedRoutes.size === allRoutes.length
      ? busPositions
      : busPositions.filter((b) => selectedRoutes.has(b.route_code))
  // Stops follow the selected routes: if empty selection, show all GTFS stops by default
  const displayStops = useMemo(() => {
    if (allRoutes.length === 0) return gtfsStops
    if (selectedRoutes.size === 0 || selectedRoutes.size === allRoutes.length) return gtfsStops
    const stopIds = new Set<string>()
    for (const route of allRoutes) {
      if (selectedRoutes.has(route.name)) {
        for (const sid of routeStopIds[route.name] ?? []) stopIds.add(sid)
      }
    }
    return gtfsStops.filter((s) => stopIds.has(s.id))
  }, [gtfsStops, selectedRoutes, allRoutes, routeStopIds])

  // Route short name -> trayek color (used for bus markers and popups).
  const routeColorMap = useMemo(() => {
    return new Map(allRoutes.map((r) => [r.name, r.color]))
  }, [allRoutes])

  const toggleRailLine = (key: string) => {
    setSelectedRailKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const railAllSelected = railLines.length > 0 && selectedRailKeys.size === railLines.length

  const toggleAllRail = () => {
    if (railAllSelected) {
      setSelectedRailKeys(new Set())
    } else {
      setSelectedRailKeys(new Set(railLines.map((l) => `${l.operator}:${l.code}`)))
    }
  }

  const filteredRailLines = useMemo(() => {
    if (mapMode !== 'rail') return []
    if (selectedRailKeys.size === 0) return railLines
    return railLines.filter((l) => selectedRailKeys.has(`${l.operator}:${l.code}`))
  }, [mapMode, railLines, selectedRailKeys])

  const filteredRailStations = useMemo(() => {
    if (mapMode !== 'rail') return []
    if (selectedRailKeys.size === 0) return railStations
    return railStations.filter((s) => s.lines.some((lk) => selectedRailKeys.has(lk)))
  }, [mapMode, railStations, selectedRailKeys])

  // Route code mapping simplified for MRT (no KRL/LRT specific branching)
  useEffect(() => {
    if (mapMode !== 'rail' || filteredRailLines.length === 0) {
      setRailVehicles([])
      return
    }
    let cancelled = false
    const fetchRailVehicles = async () => {
      const collected: { id: string; trip_id: string; lat: number; lng: number; bearing: number; status: string; route_code?: string; operator?: string; line_code?: string; distance_m?: number; route_distance_m?: number; direction?: string; next_station?: string | null; progress_pct?: number }[] = []
      await Promise.all(
        filteredRailLines.map(async (line) => {
          try {
            const res = await fetch(`${apiBaseUrl}/api/transit/positions?operator=${encodeURIComponent(line.operator)}&code=${encodeURIComponent(line.code)}`)
            if (!res.ok) return
            const data = await res.json() as { source: string; trains?: { id: string; direction: string; lat: number; lng: number; next_station: string | null; progress_pct: number; operator?: string; line_code?: string; distance_m?: number; route_distance_m?: number }[] }
            if (data.source !== 'scheduled') {
              setRailVehicles([])
              return
            }
            const routeCode = 'MRT'
            for (const train of data.trains ?? []) {
              if (typeof train.lat !== 'number' || typeof train.lng !== 'number') continue
              collected.push({
                id: train.id,
                trip_id: train.id,
                lat: train.lat,
                lng: train.lng,
                bearing: 0,
                status: 'en_route',
                 route_code: routeCode,
                 operator: train.operator ?? line.operator,
                 line_code: train.line_code ?? line.code,
                 distance_m: train.distance_m,
                 route_distance_m: train.route_distance_m,
                 direction: train.direction,
                next_station: train.next_station,
                progress_pct: train.progress_pct,
              })
            }
          } catch { /* skip this line */ }
        }),
      )
      if (cancelled) return
      setRailVehicles(collected)
    }
    void fetchRailVehicles()
    const interval = window.setInterval(() => { void fetchRailVehicles() }, 2_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [apiBaseUrl, mapMode, filteredRailLines])

  const handleStopClick = async (stopId: string) => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/stop/${encodeURIComponent(stopId)}/info`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as StopPopupData
      setStopInfo(data)
    } catch (error) {
      console.warn('Stop info fetch failed.', error)
      setStopInfo(null)
    }
  }

  const handleRailStationClick = async (stationId: string) => {
    const station = railStations.find((s) => s.id === stationId)
    if (!station) return
    try {
      const res = await fetch(`${apiBaseUrl}/api/transit/stop/${encodeURIComponent(station.operator)}/${encodeURIComponent(station.code)}/info`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { stop: { id: string; name: string; operator: string; official_name?: string; amenities?: { type: string; label: string; text: string }[] } }
      setRailStationPopup({
        stop: {
          id: data.stop.id,
          name: data.stop.name,
          operator: data.stop.operator,
          official_name: data.stop.official_name,
          amenities: data.stop.amenities,
          lng: station.lng,
          lat: station.lat,
        },
      })
    } catch (error) {
      console.warn('Rail station info fetch failed.', error)
      setRailStationPopup(null)
    }
  }

  const handleLocate = () => {
    if (!('geolocation' in navigator)) {
      setLocateError('Lokasi tidak didukung browser ini.')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setLocateError(null)
        setLocating(false)
      },
      (err) => {
        setLocating(false)
        setLocateError(err.code === 1 ? 'Izin lokasi ditolak.' : 'Tidak bisa mendapatkan lokasi.')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    )
  }

  return (
    <main className="home-page">
      <header className="home-topbar">
        <div>
          <p className="eyebrow">SELAMAT DATANG KEMBALI</p>
          <h2 id="welcome-heading">Halo, {displayName}!</h2>
        </div>
        <button
          type="button"
          className="notification-btn"
          aria-label="Buka daftar notifikasi"
          aria-expanded={notificationsOpen}
          aria-controls="notification-panel"
          onClick={() => setNotificationsOpen((open) => !open)}
        >
          <BellIcon />
          {notificationCount > 0 ? <span className="notification-btn__badge" data-count={notificationCount}>{notificationCount}</span> : null}
        </button>
      </header>
      <section id="home-hero" className="home-hero">
        <div className="home-hero__map">
          <button className={`map-filter-btn${showFilter ? ' map-filter-btn--active' : ''}`} type="button" onClick={() => setShowFilter((v) => !v)}>
            Filter Rute ({mapMode === 'bus' ? (selectedRoutes.size === 0 ? 'Semua' : selectedRoutes.size) : (selectedRailKeys.size === 0 ? 'Semua' : selectedRailKeys.size)})
          </button>
          {showFilter ? (
            <div className="map-filter-panel">
              <div className="map-filter-panel__header">
                <strong>Filter peta</strong>
                <button className="secondary-button" type="button" onClick={mapMode === 'bus' ? toggleAll : toggleAllRail}>
                  {mapMode === 'bus'
                    ? (selectedRoutes.size === allRoutes.length ? 'Hapus semua' : 'Pilih semua')
                    : (railAllSelected ? 'Hapus semua' : 'Pilih semua')}
                </button>
              </div>
              <div className="map-filter-modes" role="group" aria-label="Filter moda">
                <label className="map-filter-mode">
                  <input type="radio" name="map-mode" checked={mapMode === 'bus'} onChange={() => setMapMode('bus')} />
                  <span className="map-filter-mode__tag">Bus</span>
                </label>
                <label className="map-filter-mode">
                  <input type="radio" name="map-mode" checked={mapMode === 'rail'} onChange={() => setMapMode('rail')} />
                  <span className="map-filter-mode__tag">MRT</span>
                </label>
              </div>
              {mapMode === 'rail' ? (
                <>
                  <div className="map-filter-panel__line-head">
                    <p className="map-filter-panel__section">LIN MRT</p>
                  </div>
                  <div className="map-filter-rail-list">
                    {railLines.map((line) => {
                      const key = `${line.operator}:${line.code}`
                      const checked = selectedRailKeys.has(key)
                      return (
                        <label className="map-filter-checkbox" key={key}>
                          <input type="checkbox" checked={checked} onChange={() => toggleRailLine(key)} />
                          <span className="map-filter-checkbox__swatch" style={{ background: line.color }} aria-hidden="true" />
                          <span className="map-filter-checkbox__rail-name">{line.name}</span>
                          <span className="map-filter-checkbox__mode">{line.mode_label}</span>
                        </label>
                      )
                    })}
                  </div>
                </>
              ) : (
                <>
                  <p className="map-filter-panel__section">RUTE BUS</p>
                  <div className="map-filter-panel__list">
                    {allRoutes.map((route) => (
                      <label className="map-filter-checkbox" key={route.id}>
                        <input type="checkbox" checked={selectedRoutes.has(route.name)} onChange={() => toggleRoute(route.name)} />
                        <span className="map-filter-checkbox__swatch" style={{ background: route.color }} aria-hidden="true" />
                        <span>{route.name}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}
          <MapboxMap
            stops={mapMode === 'bus' ? displayStops : []}
            routeShapes={mapMode === 'bus' ? filteredShapes : []}
            buses={mapMode === 'bus' ? filteredBuses : []}
            scheduledVehicles={undefined}
            railVehicles={mapMode === 'rail' ? railVehicles : undefined}
            selectedRouteNames={selectedRoutes}
            routeColors={routeColorMap}
            stopPopup={mapMode === 'bus' ? stopInfo : null}
            onStopClick={(id) => { void handleStopClick(id) }}
            onStopPopupClose={() => setStopInfo(null)}
            railLines={filteredRailLines}
            railStations={filteredRailStations}
            railStationPopup={railStationPopup}
            onRailStationClick={(id) => { void handleRailStationClick(id) }}
            onRailStationPopupClose={() => setRailStationPopup(null)}
            userLocation={userLocation}
            onLocateRequest={handleLocate}
            locating={locating}
            locateError={locateError}
          />
          {mapMode === 'bus' && busSource === 'unavailable' ? (
            <p className="map-schedule-hint" role="status">Data bus realtime tidak tersedia</p>
          ) : null}

        </div>
        {notificationsOpen ? (
          <section className="notification-panel" id="notification-panel" aria-label="Daftar notifikasi">
            <p className="eyebrow">NOTIFIKASI AKTIF</p>
            {notifications.length === 0 ? (
              <p className="notification-panel__empty" role="status">Tidak ada notifikasi aktif.</p>
            ) : (
              <ul className="notification-panel__list">
                {notifications.map((notification) => (
                  <li key={notification.id}>
                    <article className="notification-banner notification-banner--safe">
                      <div>
                        <strong>{notification.title}</strong>
                        <span>{notification.message}</span>
                      </div>
                      <button className="notification-banner__dismiss" type="button" onClick={() => onDismissNotification(notification.id)} aria-label={`Tutup notifikasi ${notification.title}`}>Tutup</button>
                    </article>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </section>
      <section ref={sheetRef} className={`home-sheet${sheetExpanded ? ' home-sheet--maximized' : ''}`} aria-label="Fitur dan halte terdekat">
        <button
          type="button"
          className="home-sheet__handle"
          aria-expanded={sheetExpanded}
          aria-controls="home-sheet-scroll"
          aria-label={sheetExpanded ? 'Ciutkan panel' : 'Perbesar panel'}
          onClick={() => setSheetExpanded((current) => !current)}
        >
          <span className="home-sheet__grip" aria-hidden="true" />
        </button>
        <div className="home-sheet__scroll" id="home-sheet-scroll">
          <SearchEntry />
          <div className="home-sheet__extras">
            <ul className="feature-list">
            <li>
              <button type="button" className="feature-tile" onClick={() => onNavigate('antar-aku')}>
                <span className="feature-tile__icon"><AntarAkuIcon /></span>
                <span className="feature-tile__label">Antar Aku</span>
              </button>
            </li>
            {profile === 'tuli' ? (
              <li>
                <button type="button" className="feature-tile" onClick={() => onNavigate('transcribe')}>
                  <span className="feature-tile__icon"><TranscribeIcon /></span>
                  <span className="feature-tile__label">Transcribe</span>
                </button>
              </li>
            ) : null}
            <li>
              <button type="button" className="feature-tile" onClick={() => onNavigate('delays')}>
                <span className="feature-tile__icon"><DelaysIcon /></span>
                <span className="feature-tile__label">Keterlambatan</span>
              </button>
            </li>
            {profile === 'netra' || profile === 'daksa' ? (
              <li>
                <button type="button" className="feature-tile" onClick={() => onNavigate('side-by-side')}>
                  <span className="feature-tile__icon"><AccessibilityIcon /></span>
                  <span className="feature-tile__label">Fasilitas halte</span>
                </button>
              </li>
            ) : null}
            {profile === 'netra' ? (
              <li>
                <button type="button" className="feature-tile" onClick={() => onNavigate('netra-scan')}>
                  <span className="feature-tile__icon"><CameraIcon /></span>
                  <span className="feature-tile__label">Pemindai Netra</span>
                </button>
              </li>
            ) : null}
          </ul>
          <ArrivalsSheet />
          </div>
        </div>
      </section>
    </main>
  )
}
