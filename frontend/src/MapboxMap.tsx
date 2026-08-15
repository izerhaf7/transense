import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { Stop } from './journey'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN?.trim() || ''
const DEFAULT_CENTER: [number, number] = [106.8227, -6.1944]
const DEFAULT_ZOOM = 12
const STOP_VISIBLE_ZOOM = 13

interface RouteShape {
  id: string
  name: string
  color: string
  coordinates: [number, number][]
}

interface BusPosition {
  id: string
  route_code: string
  lat: number
  lng: number
  observed_at: string
  next_stop?: { name: string }
}

export interface StopPopupData {
  stop: { id: string; name: string; lng: number; lat: number; wheelchair_boarding?: string }
  routes: { route_code: string; color: string }[]
  arrivals: { bus_id: string; route_code: string; eta_minutes: number }[]
}

export interface WalkLine {
  from: { lng: number; lat: number }
  to: { lng: number; lat: number }
}

export interface RailLine {
  operator: string
  code: string
  name: string
  color: string
  mode_label: string
  segments: [number, number][][]
}

export interface RailStation {
  id: string
  operator: string
  code: string
  name: string
  lat: number
  lng: number
  lines: string[]
}

export interface RailStationPopupData {
  stop: {
    id: string
    name: string
    operator: string
    lng: number
    lat: number
    official_name?: string
    amenities?: { type: string; label: string; text: string }[]
  }
}

interface MapStop extends Stop {
  wheelchair_boarding?: string
  platform_code?: string
}

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 60000
  if (diff < 1) return 'Baru saja'
  if (diff < 60) return `${Math.floor(diff)} menit lalu`
  return `${Math.floor(diff / 60)} jam lalu`
}

function MapboxMap({
  stops,
  routeShapes,
  buses,
  walkLegs,
  selectedRouteNames,
  onStopClick,
  routeColors,
  stopPopup,
  onStopPopupClose,
  railLines,
  railStations,
  railStationPopup,
  onRailStationClick,
  onRailStationPopupClose,
}: {
  stops: MapStop[]
  routeShapes?: RouteShape[]
  buses?: BusPosition[]
  walkLegs?: WalkLine[]
  selectedRouteNames?: Set<string>
  onStopClick?: (stopId: string) => void
  routeColors?: Map<string, string>
  stopPopup?: StopPopupData | null
  onStopPopupClose?: () => void
  railLines?: RailLine[]
  railStations?: RailStation[]
  railStationPopup?: RailStationPopupData | null
  onRailStationClick?: (stationId: string) => void
  onRailStationPopupClose?: () => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const stopMarkersRef = useRef<mapboxgl.Marker[]>([])
  const railStationMarkersRef = useRef<mapboxgl.Marker[]>([])
  const busMarkersRef = useRef<mapboxgl.Marker[]>([])
  const stopPopupRef = useRef<mapboxgl.Popup | null>(null)
  const railStationPopupRef = useRef<mapboxgl.Popup | null>(null)
  const firstFitDoneRef = useRef(false)

  const selectedRef = useRef(selectedRouteNames)
  selectedRef.current = selectedRouteNames
  const onStopClickRef = useRef(onStopClick)
  onStopClickRef.current = onStopClick
  const onRailStationClickRef = useRef(onRailStationClick)
  onRailStationClickRef.current = onRailStationClick
  const onRailStationPopupCloseRef = useRef(onRailStationPopupClose)
  onRailStationPopupCloseRef.current = onRailStationPopupClose
  const routeColorsRef = useRef(routeColors)
  routeColorsRef.current = routeColors
  const onStopPopupCloseRef = useRef(onStopPopupClose)
  onStopPopupCloseRef.current = onStopPopupClose

  // Init map once.
  useEffect(() => {
    if (!MAPBOX_TOKEN || !containerRef.current) return
    mapboxgl.accessToken = MAPBOX_TOKEN
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: false,
    })
    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right')

    const containerSize = () => {
      const el = containerRef.current
      if (!el) return 0
      return el.clientWidth * el.clientHeight
    }

    const resizeNow = () => {
      if (!mapRef.current) return
      if (containerSize() <= 0) return
      mapRef.current.resize()
      if (firstFitDoneRef.current) {
        mapRef.current.fitBounds([[106.70, -6.35], [106.98, -6.05]], { padding: 16, maxZoom: 18 })
      }
    }

    map.on('load', () => {
      resizeNow()
      if (!firstFitDoneRef.current) {
        firstFitDoneRef.current = true
        map.fitBounds([[106.70, -6.35], [106.98, -6.05]], { padding: 16, maxZoom: 18 })
      }
    })

    // Poll until the container has real size, then resize + refit. Some mobile
    // webviews (older Chrome/Safari) neither fire ResizeObserver reliably nor
    // settle layout before the first map resize, leaving the canvas at 0px.
    let pollCount = 0
    const pollTimer = window.setInterval(() => {
      pollCount += 1
      if (containerSize() > 0) {
        resizeNow()
        if (pollCount >= 20) window.clearInterval(pollTimer)
      } else if (pollCount >= 40) {
        window.clearInterval(pollTimer)
      }
    }, 250)

    // Debounced resize + refit for the hero minimize/maximize toggle.
    let resizeTimer: number | null = null
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer !== null) return
        resizeTimer = window.setTimeout(() => {
          resizeTimer = null
          resizeNow()
        }, 260)
      })
      resizeObserver.observe(containerRef.current)
    }

    // Window-level resize as a belt-and-suspenders fallback (browser zoom,
    // orientation change, address-bar show/hide on mobile).
    const handleWindowResize = () => resizeNow()
    window.addEventListener('resize', handleWindowResize)
    window.addEventListener('orientationchange', handleWindowResize)

    return () => {
      window.clearInterval(pollTimer)
      window.removeEventListener('resize', handleWindowResize)
      window.removeEventListener('orientationchange', handleWindowResize)
      if (resizeObserver) resizeObserver.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      stopMarkersRef.current.forEach((m) => m.remove())
      stopMarkersRef.current = []
      busMarkersRef.current.forEach((m) => m.remove())
      busMarkersRef.current = []
      railStationMarkersRef.current.forEach((m) => m.remove())
      railStationMarkersRef.current = []
      map.remove()
      mapRef.current = null
      firstFitDoneRef.current = false
    }
  }, [])

  // Route shapes + walk legs (layers). Show/hide follows the filtered list,
  // so stale layers from deselected routes are removed.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return

    const wantedShapeIds = new Set((routeShapes ?? []).map((s) => s.id))
    const style = map.getStyle()
    for (const id of Object.keys(style.sources ?? {})) {
      if (id.startsWith('shape-')) {
        const routeId = id.slice('shape-'.length)
        if (!wantedShapeIds.has(routeId)) {
          if (map.getLayer(`layer-${id}`)) map.removeLayer(`layer-${id}`)
          if (map.getSource(id)) map.removeSource(id)
        }
      } else if (id.startsWith('walk-')) {
        const index = Number(id.slice('walk-'.length))
        if (!Number.isNaN(index) && index >= (walkLegs?.length ?? 0)) {
          if (map.getLayer(`layer-${id}`)) map.removeLayer(`layer-${id}`)
          if (map.getSource(id)) map.removeSource(id)
        }
      }
    }

    for (const shape of routeShapes ?? []) {
      if (shape.coordinates.length < 2) continue
      const sourceId = `shape-${shape.id}`
      if (map.getSource(sourceId)) continue
      map.addSource(sourceId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: { name: shape.name },
          geometry: { type: 'LineString', coordinates: shape.coordinates },
        },
      })
      map.addLayer({
        id: `layer-${sourceId}`,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': shape.color, 'line-width': 3, 'line-opacity': 0.7 },
      })
    }
    for (const [index, walk] of (walkLegs ?? []).entries()) {
      const sourceId = `walk-${index}`
      if (map.getSource(sourceId)) continue
      map.addSource(sourceId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [[walk.from.lng, walk.from.lat], [walk.to.lng, walk.to.lat]] },
        },
      })
      map.addLayer({
        id: `layer-${sourceId}`,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#6b7280', 'line-width': 3, 'line-opacity': 0.85, 'line-dasharray': [2, 2] },
      })
    }
  }, [routeShapes, walkLegs])

  // Rail lines (KCI/MRT/LRT) — always-on, distinct layer prefix.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return

    const wanted = new Set((railLines ?? []).map((l) => `${l.operator}:${l.code}`))
    const style = map.getStyle()
    for (const id of Object.keys(style.sources ?? {})) {
      if (!id.startsWith('rail-')) continue
      const key = id.slice('rail-'.length)
      if (!wanted.has(key)) {
        if (map.getLayer(`layer-${id}`)) map.removeLayer(`layer-${id}`)
        if (map.getSource(id)) map.removeSource(id)
      }
    }

    for (const line of railLines ?? []) {
      const validSegments = line.segments.filter((seg) => seg.length >= 2)
      if (validSegments.length === 0) continue
      const sourceId = `rail-${line.operator}:${line.code}`
      if (map.getSource(sourceId)) continue
      map.addSource(sourceId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: { name: line.name },
          geometry: { type: 'MultiLineString', coordinates: validSegments },
        },
      })
      map.addLayer({
        id: `layer-${sourceId}`,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': line.color, 'line-width': 4, 'line-opacity': 0.85 },
      })
    }
  }, [railLines])

  // Rail station markers (KCI/MRT/LRT) — clickable train icon, opens info popup.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    railStationMarkersRef.current.forEach((m) => m.remove())
    railStationMarkersRef.current = []
    for (const station of railStations ?? []) {
      if (typeof station.lng !== 'number' || typeof station.lat !== 'number') continue
      const el = document.createElement('button')
      el.className = 'rail-station-marker'
      el.type = 'button'
      el.title = station.name
      el.setAttribute('aria-label', `Stasiun ${station.name}`)
      el.style.cssText = 'width:22px;height:22px;display:flex;align-items:center;justify-content:center;background:#374151;border:2px solid #fff;border-radius:8px 8px 8px 2px;box-shadow:0 2px 5px rgba(0,0,0,0.35);cursor:pointer;padding:0'
      el.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="#fff" aria-hidden="true">' +
        '<path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2l1-1h6l1 1h2v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM7 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm-1-4.5H8V6h8v5.5z"/>' +
        '</svg>'
      el.addEventListener('click', () => {
        onRailStationClickRef.current?.(station.id)
      })
      const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([station.lng, station.lat])
        .addTo(map)
      railStationMarkersRef.current.push(marker)
    }
  }, [railStations])

  // Stop markers: render only when zoomed in, or for selected route stops.
  const renderStops = () => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    stopMarkersRef.current.forEach((m) => m.remove())
    stopMarkersRef.current = []

    const zoom = map.getZoom()
    const showAll = zoom >= STOP_VISIBLE_ZOOM
    const selected = selectedRef.current
    const hasSelection = selected && selected.size > 0 && selected.size < (stops.length || 0)

    let toRender = stops
    if (!showAll) {
      if (hasSelection) {
        // Only stops belonging to selected routes are known on the parent;
        // the parent passes the filtered list already, so just cap it.
        toRender = stops.slice(0, 300)
      } else {
        // Zoomed out with no selection: hide stops entirely.
        return
      }
    }

    const max = 400
    const capped = toRender.length > max ? toRender.filter((_, i) => i % Math.ceil(toRender.length / max) === 0) : toRender

    for (const stop of capped) {
      if (typeof stop.lng !== 'number' || typeof stop.lat !== 'number') continue
      const el = document.createElement('button')
      el.className = 'stop-marker'
      el.type = 'button'
      el.setAttribute('aria-label', stop.name)
      el.style.cssText = 'width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:#1677ff;border:2px solid #fff;border-radius:8px 8px 8px 2px;box-shadow:0 2px 5px rgba(0,0,0,0.35);cursor:pointer;padding:0'
      el.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="#fff" aria-hidden="true">' +
        '<path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4S4 2.5 4 6v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM18 11H6V6h12v5z"/>' +
        '</svg>'
      el.addEventListener('click', () => {
        onStopClickRef.current?.(stop.id)
      })
      const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([stop.lng as number, stop.lat as number])
        .addTo(map)
      stopMarkersRef.current.push(marker)
    }
  }

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const onReady = () => renderStops()
    if (map.isStyleLoaded()) onReady()
    else map.once('load', onReady)
    map.on('zoom', renderStops)
    map.on('moveend', renderStops)
    return () => {
      map.off('zoom', renderStops)
      map.off('moveend', renderStops)
    }
  }, [stops])

  // Bus markers.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    busMarkersRef.current.forEach((m) => m.remove())
    busMarkersRef.current = []
    if (!buses || buses.length === 0) return

    const shown = buses.length > 300 ? buses.filter((_, i) => i % Math.floor(buses.length / 100) === 0) : buses
    for (const bus of shown) {
      const color = routeColorsRef.current?.get(bus.route_code) ?? '#FF7A1A'
      const el = document.createElement('div')
      el.className = 'vehicle-marker'
      el.title = `${bus.route_code} · ${bus.id}`
      el.style.cssText = `display:flex;align-items:center;justify-content:center;width:24px;height:24px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 2px 5px rgba(0,0,0,0.3);cursor:pointer;font-size:11px;color:#fff;font-weight:700`
      el.textContent = bus.route_code.length <= 3 ? bus.route_code : '...'

      const popupHTML = [
        '<div class="bus-popup">',
        `<div class="bus-popup__head">`,
        `<span class="bus-popup__route" style="background:${color}">${bus.route_code}</span>`,
        `<span class="bus-popup__vehicle">${bus.id}</span>`,
        '</div>',
        bus.next_stop ? `<div class="bus-popup__row"><span class="bus-popup__label">Halte berikut</span><span class="bus-popup__value">${bus.next_stop.name}</span></div>` : '',
        `<div class="bus-popup__row"><span class="bus-popup__label">Update</span><span class="bus-popup__value">${relativeTime(bus.observed_at)}</span></div>`,
        '</div>',
      ].join('')

      const popup = new mapboxgl.Popup({ offset: 18, maxWidth: '200px', closeButton: true, closeOnClick: false })
        .setHTML(popupHTML)
      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([bus.lng, bus.lat])
        .setPopup(popup)
        .addTo(map)
      busMarkersRef.current.push(marker)
    }
  }, [buses])

  // Stop info popup: shown near the clicked stop, styled like the bus popup.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const prev = stopPopupRef.current
    if (prev) {
      prev.remove()
      stopPopupRef.current = null
    }
    if (!stopPopup) return

    const routeColorsMap = new Map(stopPopup.routes.map((r) => [r.route_code, r.color]))
    const routeChips = stopPopup.routes.map(
      (r) => `<span class="stop-popup__chip" style="background:${r.color}">${r.route_code}</span>`,
    ).join('')
    const arrivalRows = stopPopup.arrivals.length === 0
      ? '<p class="stop-popup__empty">Tidak ada bus yang akan tiba dalam waktu dekat.</p>'
      : stopPopup.arrivals.map((a) => {
          const color = routeColorsMap.get(a.route_code) ?? '#1677ff'
          return [
            '<div class="bus-popup__row">',
            `<span class="bus-popup__route" style="background:${color}">${a.route_code}</span>`,
            `<span class="bus-popup__value">${a.eta_minutes} menit · ${a.bus_id}</span>`,
            '</div>',
          ].join('')
        }).join('')

    const popupHTML = [
      '<div class="stop-popup">',
      `<div class="stop-popup__head">`,
      `<strong>${stopPopup.stop.name}</strong>`,
      '</div>',
      stopPopup.stop.wheelchair_boarding === '1' ? '<span class="state-badge state-badge--safe">AKSESIBEL KURSI RODA</span>' : '',
      stopPopup.routes.length ? `<div class="stop-popup__routes">${routeChips}</div>` : '',
      '<div class="stop-popup__arrivals">',
      '<p class="stop-popup__label">KEDATANGAN BUS</p>',
      arrivalRows,
      '</div>',
      '</div>',
    ].join('')

    const popup = new mapboxgl.Popup({ offset: 20, maxWidth: '240px', closeButton: true, closeOnClick: false })
      .setLngLat([stopPopup.stop.lng, stopPopup.stop.lat])
      .setHTML(popupHTML)
      .addTo(map)
    popup.on('close', () => {
      onStopPopupCloseRef.current?.()
    })
    stopPopupRef.current = popup
  }, [stopPopup])

  // Rail station info popup: shown near the clicked station.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const prev = railStationPopupRef.current
    if (prev) {
      prev.remove()
      railStationPopupRef.current = null
    }
    if (!railStationPopup) return

    const amenities = railStationPopup.stop.amenities ?? []
    const amenityChips = amenities.length
      ? amenities.map((a) => `<span class="stop-popup__amenity">${a.label}${a.text ? ` · ${a.text}` : ''}</span>`).join('')
      : '<span class="stop-popup__empty">Information not available</span>'

    const officialName = railStationPopup.stop.official_name
      ? `<p class="stop-popup__official">${railStationPopup.stop.official_name}</p>`
      : ''

    const popupHTML = [
      '<div class="stop-popup">',
      '<div class="stop-popup__head">',
      `<strong>${railStationPopup.stop.name}</strong>`,
      '</div>',
      officialName,
      '<p class="stop-popup__label">FASILITAS</p>',
      `<div class="stop-popup__amenities">${amenityChips}</div>`,
      '</div>',
    ].join('')

    const popup = new mapboxgl.Popup({ offset: 20, maxWidth: '280px', closeButton: true, closeOnClick: false })
      .setLngLat([railStationPopup.stop.lng, railStationPopup.stop.lat])
      .setHTML(popupHTML)
      .addTo(map)
    popup.on('close', () => {
      onRailStationPopupCloseRef.current?.()
    })
    railStationPopupRef.current = popup
  }, [railStationPopup])

  if (!MAPBOX_TOKEN) {
    return (
      <div className="map-placeholder" role="status">
        <p className="eyebrow">PETA / MAPBOX</p>
        <h3>Peta belum aktif</h3>
        <p>Isi <code>VITE_MAPBOX_TOKEN</code> di file <code>.env</code> (root repo) untuk menampilkan peta TransJakarta.</p>
      </div>
    )
  }

  return <div className="map-canvas" ref={containerRef} aria-label="Peta TransJakarta — halte dan posisi armada" />
}

export default MapboxMap
