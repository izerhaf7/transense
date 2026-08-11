import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { Route, Stop, Vehicle } from './journey'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN?.trim() || ''
const DEFAULT_CENTER: [number, number] = [106.8227, -6.1944]
const DEFAULT_ZOOM = 12

function MapboxMap({ stops, vehicles, routes }: { stops: Stop[]; vehicles: Vehicle[]; routes: Route[] }) {
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

      for (const stop of locatedStops) {
        const lng = stop.lng as number
        const lat = stop.lat as number
        new mapboxgl.Marker({ color: '#1677ff' })
          .setLngLat([lng, lat])
          .setPopup(new mapboxgl.Popup({ offset: 24 }).setHTML(`<strong>${stop.name}</strong>`))
          .addTo(map)
        bounds.extend([lng, lat])
      }

      for (const route of routes) {
        const coords: [number, number][] = []
        for (const stopId of route.stop_ids) {
          const stop = stops.find((s) => s.id === stopId)
          if (stop && typeof stop.lng === 'number' && typeof stop.lat === 'number') {
            coords.push([stop.lng as number, stop.lat as number])
          }
        }
        if (coords.length < 2) continue

        const sourceId = `route-line-${route.id}`
        map.addSource(sourceId, {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: { name: route.name },
            geometry: { type: 'LineString', coordinates: coords },
          },
        })
        map.addLayer({
          id: `layer-${sourceId}`,
          type: 'line',
          source: sourceId,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#B83630',
            'line-width': 3,
            'line-dasharray': [2, 2],
            'line-opacity': 0.8,
          },
        })
      }

      for (const vehicle of vehicles) {
        const stop = stops.find((s) => s.id === vehicle.position)
        if (!stop || typeof stop.lng !== 'number' || typeof stop.lat !== 'number') continue
        const lng = stop.lng as number
        const lat = stop.lat as number

        const el = document.createElement('div')
        el.className = 'vehicle-marker'
        el.innerHTML = '🚍'
        el.setAttribute('aria-label', vehicle.id)

        const popup = new mapboxgl.Popup({ offset: 20 }).setHTML(
          `<strong>${vehicle.id}</strong><br>ETA: ${vehicle.eta_minutes} menit`
        )
        new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lng + 0.0002, lat - 0.0002])
          .setPopup(popup)
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
  }, [stops, vehicles, routes])

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
