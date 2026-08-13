import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { Stop } from './journey'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN?.trim() || ''
const DEFAULT_CENTER: [number, number] = [106.8227, -6.1944]
const DEFAULT_ZOOM = 12

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

export interface WalkLine {
  from: { lng: number; lat: number }
  to: { lng: number; lat: number }
}

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 60000
  if (diff < 1) return 'Baru saja'
  if (diff < 60) return `${Math.floor(diff)} menit lalu`
  return `${Math.floor(diff / 60)} jam lalu`
}

function MapboxMap({ stops, routeShapes, buses, walkLegs }: { stops: Stop[]; routeShapes?: RouteShape[]; buses?: BusPosition[]; walkLegs?: WalkLine[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const busMarkersRef = useRef<mapboxgl.Marker[]>([])

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

    map.on('load', () => {
      map.resize()
      const bounds = new mapboxgl.LngLatBounds()
      let hasLocatedPoints = false
      const extendBounds = (lng: number, lat: number) => {
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
        bounds.extend([lng, lat])
        hasLocatedPoints = true
      }
      const locatedStops = stops.filter((stop) => typeof stop.lng === 'number' && typeof stop.lat === 'number')

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
          paint: {
            'line-color': shape.color,
            'line-width': 2,
            'line-opacity': 0.6,
          },
        })
        for (const [lng, lat] of shape.coordinates) {
          extendBounds(lng, lat)
        }
      }

      for (const [index, walk] of (walkLegs ?? []).entries()) {
        if (!Number.isFinite(walk.from.lng) || !Number.isFinite(walk.from.lat) || !Number.isFinite(walk.to.lng) || !Number.isFinite(walk.to.lat)) continue
        const sourceId = `walk-${index}`
        if (map.getSource(sourceId)) continue
        map.addSource(sourceId, {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [[walk.from.lng, walk.from.lat], [walk.to.lng, walk.to.lat]],
            },
          },
        })
        map.addLayer({
          id: `layer-${sourceId}`,
          type: 'line',
          source: sourceId,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#6b7280',
            'line-width': 3,
            'line-opacity': 0.85,
            'line-dasharray': [2, 2],
          },
        })
        extendBounds(walk.from.lng, walk.from.lat)
        extendBounds(walk.to.lng, walk.to.lat)
      }

      const shownStops = locatedStops.length > 200
        ? locatedStops.filter((_, i) => i % Math.floor(locatedStops.length / 60) === 0)
        : locatedStops

      for (const stop of shownStops) {
        const lng = stop.lng as number
        const lat = stop.lat as number
        new mapboxgl.Marker({ color: '#1677ff' })
          .setLngLat([lng, lat])
          .addTo(map)
        extendBounds(lng, lat)
      }

      if (hasLocatedPoints) {
        map.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 600 })
      }
    })

    const resizeObserver = new ResizeObserver(() => {
      map.resize()
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      busMarkersRef.current.forEach((m) => m.remove())
      busMarkersRef.current = []
      map.remove()
      mapRef.current = null
    }
  }, [stops, routeShapes, walkLegs])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    busMarkersRef.current.forEach((m) => m.remove())
    busMarkersRef.current = []

    if (!buses || buses.length === 0) return

    const shown = (buses as BusPosition[]).length > 300
      ? (buses as BusPosition[]).filter((_, i) => i % Math.floor((buses as BusPosition[]).length / 100) === 0)
      : (buses as BusPosition[])

    for (const bus of shown) {
      const el = document.createElement('div')
      el.className = 'vehicle-marker'
      el.title = `${bus.route_code} · ${bus.id}`
      el.style.cssText = 'display:flex;align-items:center;justify-content:center;width:28px;height:28px;background:#FF7A1A;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:pointer;font-size:12px;color:#fff;font-weight:700'
      el.textContent = bus.route_code.length <= 3 ? bus.route_code : '...'

      const popupHTML = [
        '<div style="font-family:system-ui,sans-serif;font-weight:600;min-width:160px">',
        `<p style="margin:0;font-size:11px;text-transform:uppercase;color:#6b7280">Nomor Kendaraan</p>`,
        `<p style="margin:0 0 8px;font-size:16px">${bus.id}</p>`,
        `<p style="margin:0;font-size:11px;text-transform:uppercase;color:#6b7280">Layanan</p>`,
        `<p style="margin:0 0 8px;font-size:16px">Transjakarta</p>`,
        `<p style="margin:0;font-size:11px;text-transform:uppercase;color:#6b7280">Trayek</p>`,
        `<p style="margin:0 0 8px;font-size:16px">${bus.route_code}</p>`,
        bus.next_stop ? `<p style="margin:0;font-size:11px;text-transform:uppercase;color:#6b7280">Halte Berikutnya</p><p style="margin:0 0 8px;font-size:16px">${bus.next_stop.name}</p>` : '',
        `<p style="margin:0;font-size:11px;text-transform:uppercase;color:#6b7280">Update Terakhir</p>`,
        `<p style="margin:0;font-size:16px">${relativeTime(bus.observed_at)}</p>`,
        '</div>',
      ].join('')

      const popup = new mapboxgl.Popup({ offset: 20, maxWidth: '240px' })
        .setHTML(popupHTML)

      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([bus.lng, bus.lat])
        .setPopup(popup)
        .addTo(map)
      busMarkersRef.current.push(marker)
    }
  }, [buses])

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
