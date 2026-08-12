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
}

function MapboxMap({ stops, routeShapes, buses }: { stops: Stop[]; routeShapes?: RouteShape[]; buses?: BusPosition[] }) {
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
        bounds.extend([lng, lat])
      }

      if (locatedStops.length > 0) {
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
  }, [stops, routeShapes])

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

      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([bus.lng, bus.lat])
        .addTo(map)
      busMarkersRef.current.push(marker)
    }
  }, [buses])

  if (!MAPBOX_TOKEN) {
    return (
      <div className="map-placeholder" role="status">
        <p className="eyebrow">PETA / MAPBOX</p>
        <h3>Peta belum aktif</h3>
        <p>Isi <code>VITE_MAPBOX_TOKEN</code> di file <code>.env.local</code> untuk menampilkan peta TransJakarta.</p>
      </div>
    )
  }

  return <div className="map-canvas" ref={containerRef} aria-label="Peta TransJakarta — halte dan posisi armada" />
}

export default MapboxMap
