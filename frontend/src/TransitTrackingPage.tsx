import { useEffect, useRef, useState } from 'react'
import MapboxMap from './MapboxMap'
import type { Stop } from './journey'

type ViewMode = 'schematic' | 'mapbox'
type TrackingMode = 'vehicle' | 'gps'

interface TrackStop extends Stop {
  sequence?: number
}

interface TrackResponse {
  status: 'approaching' | 'arrived' | 'en_route' | 'not_found' | 'not_on_route' | 'unavailable'
  vehicle?: { id: string; route_code: string; lat: number; lng: number; observed_at: string }
  route?: { id: string; name: string; headsign: string; stops: TrackStop[] }
  target_stop?: { id: string; name: string; lat: number; lng: number }
  next_stop?: { name: string }
  eta_minutes?: number
  error?: string
}

interface TransitTrackingPageProps {
  apiBaseUrl: string
  initialTarget?: Stop | null
  initialVehicleId?: string
  initialMode?: TrackingMode
  onBack?: () => void
}

function TransitTrackingPage({ apiBaseUrl, initialTarget, initialVehicleId, initialMode, onBack }: TransitTrackingPageProps) {
  const [mode, setMode] = useState<TrackingMode>(initialMode ?? 'vehicle')
  const [viewMode, setViewMode] = useState<ViewMode>('schematic')
  const [vehicleId, setVehicleId] = useState(initialVehicleId ?? '')
  const [targetQuery, setTargetQuery] = useState(initialTarget?.name ?? '')
  const [target, setTarget] = useState<Stop | null>(initialTarget ?? null)
  const [suggestions, setSuggestions] = useState<Stop[]>([])
  const [track, setTrack] = useState<TrackResponse | null>(null)
  const [tracking, setTracking] = useState(false)
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const lastAlert = useRef<string>('')

  const searchStops = async (query: string) => {
    setTargetQuery(query)
    if (query.trim().length < 2) {
      setSuggestions([])
      return
    }
    try {
      const response = await fetch(`${apiBaseUrl}/api/gtfs/stops/search?q=${encodeURIComponent(query.trim())}`)
      if (!response.ok) return
      const data = await response.json() as { stops: Stop[] }
      setSuggestions(data.stops ?? [])
    } catch {
      setSuggestions([])
    }
  }

  const startTracking = () => {
    setErrorMessage('')
    if (!target) {
      setErrorMessage('Pilih halte tujuan dulu.')
      return
    }
    if (mode === 'vehicle' && !vehicleId.trim()) {
      setErrorMessage('Masukkan nomor kendaraan yang ingin diikuti.')
      return
    }
    if (mode === 'gps' && !gps) {
      setErrorMessage('Lokasi GPS belum tersedia.')
      return
    }
    setTracking(true)
  }

  useEffect(() => {
    if (!tracking || !target) return
    let cancelled = false
    const poll = async () => {
      const params = new URLSearchParams({ target_stop_id: target.id })
      if (mode === 'vehicle') params.set('vehicle_id', vehicleId.trim())
      if (mode === 'gps' && gps) {
        params.set('user_lat', String(gps.lat))
        params.set('user_lng', String(gps.lng))
      }
      try {
        const response = await fetch(`${apiBaseUrl}/api/journey/track?${params}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json() as TrackResponse
        if (!cancelled) setTrack(data)
      } catch (error) {
        if (!cancelled) setErrorMessage('Gagal mengambil posisi armada terbaru.')
        console.warn('Journey tracking failed.', error)
      }
    }
    void poll()
    const interval = window.setInterval(poll, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [tracking, target, mode, vehicleId, gps])

  useEffect(() => {
    if (!tracking || mode !== 'gps' || !navigator.geolocation) return
    const watcher = navigator.geolocation.watchPosition(
      (position) => setGps({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setErrorMessage('GPS tidak tersedia. Coba mode nomor kendaraan.'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 10_000 },
    )
    return () => navigator.geolocation.clearWatch(watcher)
  }, [tracking, mode])

  useEffect(() => {
    if (!track?.vehicle || !track.status) return
    if (track.status === 'approaching' && lastAlert.current !== 'approaching') {
      lastAlert.current = 'approaching'
      navigator.vibrate?.([300, 120, 300])
    }
    if (track.status === 'arrived' && lastAlert.current !== 'arrived') {
      lastAlert.current = 'arrived'
      navigator.vibrate?.([500, 180, 500, 180, 900])
    }
  }, [track])

  const chooseTarget = (stop: Stop) => {
    setTarget(stop)
    setTargetQuery(stop.name)
    setSuggestions([])
  }

  const routeStops = track?.route?.stops ?? []
  const mapStops = routeStops.map((stop) => ({ id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng }))
  const mapBuses = track?.vehicle ? [{ ...track.vehicle, next_stop: track.next_stop }] : []

  return (
    <main className="page-content inner-page tracking-page">
      {onBack ? (
        <div className="tracking-back-row">
          <button className="secondary-button" type="button" onClick={onBack}>Kembali ke daftar rute</button>
        </div>
      ) : null}
      <section className="page-intro">
        <p className="eyebrow">ANTAR AKU / TRACKING PERJALANAN</p>
        <h2>Ikuti perjalananmu</h2>
        <p>Pilih halte tujuan dan ikuti bus TransJakarta dengan cue visual serta getar.</p>
      </section>

      <section className="tracking-setup">
        <div className="tracking-mode-toggle">
          <button className={mode === 'vehicle' ? 'tracking-mode tracking-mode--active' : 'tracking-mode'} type="button" onClick={() => setMode('vehicle')}>Nomor kendaraan</button>
          <button className={mode === 'gps' ? 'tracking-mode tracking-mode--active' : 'tracking-mode'} type="button" onClick={() => setMode('gps')}>GPS HP</button>
        </div>
        {mode === 'vehicle' ? (
          <label className="tracking-field">Nomor kendaraan<input value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} placeholder="Contoh: BMP-240360" /></label>
        ) : (
          <p className="tracking-gps-status">{gps ? `GPS aktif · ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : 'Mengambil posisi GPS…'}</p>
        )}
        <label className="tracking-field">Halte tujuan
          <input value={targetQuery} onChange={(event) => { void searchStops(event.target.value) }} placeholder="Contoh: Bundaran HI Astra" autoComplete="off" />
        </label>
        {suggestions.length ? <div className="tracking-suggestions">{suggestions.map((stop) => <button type="button" key={stop.id} onClick={() => chooseTarget(stop)}>{stop.name}</button>)}</div> : null}
        <button className="primary-button" type="button" onClick={tracking ? () => { setTracking(false); setTrack(null); lastAlert.current = '' } : startTracking}>
          {tracking ? 'Hentikan tracking' : 'Mulai tracking'} <span aria-hidden="true">→</span>
        </button>
      </section>

      {errorMessage ? <div className="notice-box notice-box--danger" role="alert"><strong>Tracking belum aktif</strong><span>{errorMessage}</span></div> : null}

      {track?.vehicle && track.route ? (
        <section className={`tracking-active tracking-active--${track.status}`}>
          <div className="tracking-active__header">
            <div><p className="eyebrow">PERJALANAN AKTIF</p><h3>Trayek {track.vehicle.route_code} · {track.route.headsign}</h3></div>
            <span className="state-badge state-badge--safe">{track.status === 'arrived' ? 'SUDAH TIBA' : track.status === 'approaching' ? 'MENDEKAT' : 'BERJALAN'}</span>
          </div>
          <p className="tracking-cue">{track.status === 'arrived' ? `Kamu sudah tiba di ${track.target_stop?.name}.` : track.next_stop ? `Halte berikutnya: ${track.next_stop.name}. ${track.eta_minutes} menit menuju tujuan.` : `Menuju ${track.target_stop?.name}.`}</p>
          <div className="tracking-view-toggle">
            <button className={viewMode === 'schematic' ? 'tracking-view-btn tracking-view-btn--active' : 'tracking-view-btn'} type="button" onClick={() => setViewMode('schematic')}>Schematic</button>
            <button className={viewMode === 'mapbox' ? 'tracking-view-btn tracking-view-btn--active' : 'tracking-view-btn'} type="button" onClick={() => setViewMode('mapbox')}>Mapbox</button>
          </div>
          {viewMode === 'schematic' ? (
            <ol className="tracking-schematic">{routeStops.map((stop) => <li className={stop.id === track.target_stop?.id ? 'tracking-schematic__stop tracking-schematic__stop--target' : 'tracking-schematic__stop'} key={stop.id}><span className="tracking-schematic__dot" /> <span>{stop.name}</span>{stop.name === track.next_stop?.name ? <small>BERIKUTNYA</small> : null}</li>)}</ol>
          ) : <div className="tracking-map"><MapboxMap stops={mapStops} buses={mapBuses} /></div>}
        </section>
      ) : null}
    </main>
  )
}

export default TransitTrackingPage
