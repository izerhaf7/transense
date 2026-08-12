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

function MapboxMap({ stops, routeShapes }: { stops: Stop[]; routeShapes?: RouteShape[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)

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
          .setPopup(new mapboxgl.Popup({ offset: 24 }).setHTML(`<strong>${stop.name}</strong>`))
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
      map.remove()
      mapRef.current = null
    }
  }, [stops, routeShapes])

  if (!MAPBOX_TOKEN) {
    return (
      <div className="map-placeholder" role="status">
        <p className="eyebrow">PETA / MAPBOX</p>
        <h3>Peta belum aktif</h3>
        <p>Isi <code>VITE_MAPBOX_TOKEN</code> di file <code>.env.local</code> untuk menampilkan peta TransJakarta.</p>
      </div>
    )
  }

  return <div className="map-canvas" ref={containerRef} aria-label="Peta halte TransJakarta" />
}

export default MapboxMap
