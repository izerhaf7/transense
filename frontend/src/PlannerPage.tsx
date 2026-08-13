import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import MapboxMap from './MapboxMap'
import type { WalkLine } from './MapboxMap'
import TransitTrackingPage from './TransitTrackingPage'
import type { Stop } from './journey'

interface PlannerPageProps {
  apiBaseUrl: string
}

interface PlanPoint {
  stop_id?: string
  name: string
  lat: number
  lng: number
}

interface PlanRouteInfo {
  id: string
  short_name: string
  color?: string
}

interface PlanLeg {
  mode: 'WALK' | 'BUS'
  from: PlanPoint
  to: PlanPoint
  start_time?: string
  end_time?: string
  duration_minutes: number
  distance_m: number
  route?: PlanRouteInfo
  headsign?: string
  trip_id?: string
}

interface PlanItinerary {
  legs: PlanLeg[]
  transfers: number
  walk_distance_m: number
  walk_minutes?: number
  waiting_minutes?: number
  total_minutes: number
}

interface PlanResponse {
  itineraries: PlanItinerary[]
  source: 'gtfs' | 'unavailable'
}

interface PlannerShape {
  id: string
  name: string
  color: string
  coordinates: [number, number][]
}

type PlannerPhase = 'plan' | 'tracking'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPlanPoint(value: unknown): value is PlanPoint {
  if (!isRecord(value)) return false
  return typeof value.name === 'string'
    && typeof value.lat === 'number'
    && typeof value.lng === 'number'
    && (value.stop_id === undefined || typeof value.stop_id === 'string')
}

function isPlanRoute(value: unknown): value is PlanRouteInfo {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.short_name === 'string'
    && (value.color === undefined || typeof value.color === 'string')
}

function isPlanLeg(value: unknown): value is PlanLeg {
  if (!isRecord(value)) return false
  const isWalkLeg = value.mode === 'WALK'
  const isBusLeg = value.mode === 'BUS'
  if (!isWalkLeg && !isBusLeg) return false
  if (!isPlanPoint(value.from) || !isPlanPoint(value.to)) return false
  if (typeof value.duration_minutes !== 'number' || typeof value.distance_m !== 'number') return false
  if (value.route !== undefined && !isPlanRoute(value.route)) return false
  return (value.headsign === undefined || typeof value.headsign === 'string')
    && (value.trip_id === undefined || typeof value.trip_id === 'string')
    && (value.start_time === undefined || typeof value.start_time === 'string')
    && (value.end_time === undefined || typeof value.end_time === 'string')
}

function isPlanItinerary(value: unknown): value is PlanItinerary {
  if (!isRecord(value)) return false
  return Array.isArray(value.legs)
    && value.legs.every(isPlanLeg)
    && typeof value.transfers === 'number'
    && typeof value.walk_distance_m === 'number'
    && typeof value.total_minutes === 'number'
    && (value.walk_minutes === undefined || typeof value.walk_minutes === 'number')
    && (value.waiting_minutes === undefined || typeof value.waiting_minutes === 'number')
}

function isPlanResponse(value: unknown): value is PlanResponse {
  if (!isRecord(value)) return false
  return Array.isArray(value.itineraries)
    && value.itineraries.every(isPlanItinerary)
    && (value.source === 'gtfs' || value.source === 'unavailable')
}

function formatClock(value: string | undefined): string {
  if (!value) return '—'
  const match = /(\d{2}):(\d{2})/.exec(value)
  return match ? `${match[1]}:${match[2]}` : value
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${Math.round(meters / 100) / 10} km`
  return `${Math.round(meters)} m`
}

function LegRow({ leg, index }: { leg: PlanLeg; index: number }) {
  if (leg.mode === 'WALK') {
    return (
      <li className="leg leg--walk">
        <span className="leg__marker" aria-hidden="true">⌁</span>
        <div className="leg__body">
          <p className="leg__eyebrow">LANGKAH {index + 1} · JALAN KAKI</p>
          <strong>Jalan kaki dari {leg.from.name} ke {leg.to.name}</strong>
          <p className="leg__meta">{formatDistance(leg.distance_m)} · {leg.duration_minutes} menit</p>
        </div>
      </li>
    )
  }
  return (
    <li className="leg leg--bus">
      <span className="leg__route-badge" style={{ background: leg.route?.color ?? 'var(--brand-color-accent)' }} aria-hidden="true">{leg.route?.short_name ?? 'BUS'}</span>
      <div className="leg__body">
        <p className="leg__eyebrow">LANGKAH {index + 1} · NAIK BUS</p>
        <strong>Koridor {leg.route?.short_name ?? leg.route?.id ?? 'bus'} · {leg.headsign ?? 'menuju tujuan'}</strong>
        <p className="leg__stops">
          <span>{formatClock(leg.start_time)} naik di {leg.from.name}</span>
          <span aria-hidden="true">→</span>
          <span>{formatClock(leg.end_time)} turun di {leg.to.name}</span>
        </p>
        <p className="leg__meta">{leg.duration_minutes} menit · {formatDistance(leg.distance_m)}</p>
      </div>
    </li>
  )
}

function PlannerPage({ apiBaseUrl }: PlannerPageProps) {
  const [originQuery, setOriginQuery] = useState('')
  const [origin, setOrigin] = useState<PlanPoint | null>(null)
  const [originSuggestions, setOriginSuggestions] = useState<PlanPoint[]>([])
  const [destinationQuery, setDestinationQuery] = useState('')
  const [destination, setDestination] = useState<PlanPoint | null>(null)
  const [destinationSuggestions, setDestinationSuggestions] = useState<PlanPoint[]>([])
  const [planState, setPlanState] = useState<'idle' | 'loading' | 'results' | 'error'>('idle')
  const [planResponse, setPlanResponse] = useState<PlanResponse | null>(null)
  const [planError, setPlanError] = useState('')
  const [selectedItinerary, setSelectedItinerary] = useState(0)
  const [planShapes, setPlanShapes] = useState<PlannerShape[]>([])
  const [walkLegs, setWalkLegs] = useState<WalkLine[]>([])
  const [phase, setPhase] = useState<PlannerPhase>('plan')
  const [trackTarget, setTrackTarget] = useState<Stop | null>(null)

  const searchStops = async (query: string, kind: 'origin' | 'destination') => {
    if (kind === 'origin') setOriginQuery(query)
    else setDestinationQuery(query)
    if (query.trim().length < 2) {
      if (kind === 'origin') setOriginSuggestions([])
      else setDestinationSuggestions([])
      return
    }
    try {
      const response = await fetch(`${apiBaseUrl}/api/gtfs/stops/search?q=${encodeURIComponent(query.trim())}`)
      if (!response.ok) return
      const data = await response.json() as { stops: { id: string; name: string; lat: number; lng: number }[] }
      const stops: PlanPoint[] = (data.stops ?? []).map((stop) => ({ stop_id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng }))
      if (kind === 'origin') setOriginSuggestions(stops)
      else setDestinationSuggestions(stops)
    } catch (error: unknown) {
      if (kind === 'origin') setOriginSuggestions([])
      else setDestinationSuggestions([])
      console.warn('Stop search failed.', error)
    }
  }

  const choosePoint = (kind: 'origin' | 'destination', point: PlanPoint) => {
    if (kind === 'origin') {
      setOrigin(point)
      setOriginQuery(point.name)
      setOriginSuggestions([])
    } else {
      setDestination(point)
      setDestinationQuery(point.name)
      setDestinationSuggestions([])
    }
  }

  const runPlan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!origin) {
      setPlanState('error')
      setPlanError('Pilih titik asal dari saran halte dulu.')
      return
    }
    if (!destination) {
      setPlanState('error')
      setPlanError('Pilih titik tujuan dari saran halte dulu.')
      return
    }
    setPlanState('loading')
    setPlanResponse(null)
    setPlanError('')
    setSelectedItinerary(0)
    setPlanShapes([])
    setWalkLegs([])

    const params = new URLSearchParams()
    if (origin.stop_id) {
      params.set('from_stop', origin.stop_id)
    } else {
      params.set('from_lat', String(origin.lat))
      params.set('from_lng', String(origin.lng))
    }
    if (destination.stop_id) {
      params.set('to_stop', destination.stop_id)
    } else {
      params.set('to_lat', String(destination.lat))
      params.set('to_lng', String(destination.lng))
    }

    try {
      const response = await fetch(`${apiBaseUrl}/api/journey/plan?${params}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload: unknown = await response.json()
      const parsed = isPlanResponse(payload) ? payload : null
      if (!parsed) throw new Error('respons plan tidak valid')
      setPlanResponse(parsed)
      setPlanState('results')
    } catch (error: unknown) {
      setPlanState('error')
      setPlanError('Gagal mencari rute. Periksa koneksi backend dan coba lagi.')
      console.warn('Journey plan failed.', error)
    }
  }

  useEffect(() => {
    const itinerary = planResponse?.itineraries[selectedItinerary]
    if (!itinerary) {
      setPlanShapes([])
      setWalkLegs([])
      return
    }
    const controller = new AbortController()
    const load = async () => {
      const shapes: PlannerShape[] = []
      const walks: WalkLine[] = []
      for (const leg of itinerary.legs) {
        if (leg.mode === 'BUS' && leg.route) {
          try {
            const response = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(leg.route.id)}/shape`, { signal: controller.signal })
            if (!response.ok) continue
            const data = await response.json() as { coordinates: [number, number][] }
            if (data.coordinates.length >= 2) {
              shapes.push({ id: leg.route.id, name: leg.route.short_name, color: leg.route.color ?? '#1677ff', coordinates: data.coordinates })
            }
          } catch (error: unknown) {
            if (error instanceof DOMException && error.name === 'AbortError') return
            console.warn('Route shape fetch failed.', error)
          }
        } else if (leg.mode === 'WALK') {
          if (Number.isFinite(leg.from.lat) && Number.isFinite(leg.from.lng) && Number.isFinite(leg.to.lat) && Number.isFinite(leg.to.lng)) {
            walks.push({ from: { lng: leg.from.lng, lat: leg.from.lat }, to: { lng: leg.to.lng, lat: leg.to.lat } })
          }
        }
      }
      if (!controller.signal.aborted) {
        setPlanShapes(shapes)
        setWalkLegs(walks)
      }
    }
    void load()
    return () => controller.abort()
  }, [planResponse, selectedItinerary, apiBaseUrl])

  const plannerStops = useMemo(() => {
    const itinerary = planResponse?.itineraries[selectedItinerary]
    if (!itinerary) return []
    const stops: Stop[] = []
    for (const leg of itinerary.legs) {
      const candidates = [leg.from, leg.to]
      for (const point of candidates) {
        const key = point.stop_id ?? `${point.name}:${point.lat},${point.lng}`
        if (stops.some((stop) => stop.id === key)) continue
        stops.push({ id: key, name: point.name, lat: point.lat, lng: point.lng })
      }
    }
    return stops
  }, [planResponse, selectedItinerary])

  const startTrackingForChosenRoute = () => {
    const itinerary = planResponse?.itineraries[selectedItinerary]
    const lastLeg = itinerary?.legs[itinerary.legs.length - 1]
    if (!itinerary || !lastLeg) return
    const lastPoint = lastLeg.to
    const target: Stop = {
      id: lastPoint.stop_id ?? `plan-destination-${selectedItinerary}`,
      name: lastPoint.name,
      lat: lastPoint.lat,
      lng: lastPoint.lng,
    }
    setTrackTarget(target)
    setPhase('tracking')
  }

  if (phase === 'tracking' && trackTarget) {
    return (
      <TransitTrackingPage
        apiBaseUrl={apiBaseUrl}
        initialTarget={trackTarget}
        initialMode="gps"
        onBack={() => setPhase('plan')}
      />
    )
  }

  const itineraries = planResponse?.itineraries ?? []
  const selected = planResponse?.itineraries[selectedItinerary] ?? null
  const unavailable = planResponse?.source === 'unavailable'
  const noRoute = planResponse?.source === 'gtfs' && itineraries.length === 0

  return (
    <main className="page-content inner-page planner-page">
      <section className="page-intro">
        <p className="eyebrow">ANTAR AKU / PERENCANA RUTE</p>
        <h2>Cari rute TransJakarta</h2>
        <p>Masukkan asal dan tujuan, lalu pilih rute terbaik. Setelah memilih, kamu bisa mengikuti armada secara langsung.</p>
      </section>

      <form className="planner-form" onSubmit={(event) => { void runPlan(event) }} role="search">
        <label className="planner-field">
          <span className="planner-field__label">Dari</span>
          <input
            value={originQuery}
            onChange={(event) => { void searchStops(event.target.value, 'origin') }}
            placeholder="Asal, mis. Halte Bundaran HI"
            autoComplete="off"
          />
        </label>
        {originSuggestions.length ? (
          <div className="planner-suggestions" role="listbox" aria-label="Saran halte asal">
            {originSuggestions.map((point) => (
              <button type="button" key={point.stop_id ?? point.name} onClick={() => choosePoint('origin', point)}>{point.name}</button>
            ))}
          </div>
        ) : null}
        <label className="planner-field">
          <span className="planner-field__label">Ke</span>
          <input
            value={destinationQuery}
            onChange={(event) => { void searchStops(event.target.value, 'destination') }}
            placeholder="Tujuan, mis. Halte Karet"
            autoComplete="off"
          />
        </label>
        {destinationSuggestions.length ? (
          <div className="planner-suggestions" role="listbox" aria-label="Saran halte tujuan">
            {destinationSuggestions.map((point) => (
              <button type="button" key={point.stop_id ?? point.name} onClick={() => choosePoint('destination', point)}>{point.name}</button>
            ))}
          </div>
        ) : null}
        <button className="primary-button" type="submit" disabled={planState === 'loading'}>
          {planState === 'loading' ? 'Mencari rute…' : 'Cari rute'} <span aria-hidden="true">→</span>
        </button>
      </form>

      {planState === 'error' ? (
        <div className="notice-box notice-box--danger" role="alert"><strong>Rute belum ditemukan</strong><span>{planError}</span></div>
      ) : null}

      {planState === 'loading' ? (
        <section className="planner-status" role="status" aria-live="polite">
          <h3>Mencari rute tercepat…</h3>
          <p>Menghitung jalan kaki, naik bus, dan transfer dari data jadwal statis.</p>
        </section>
      ) : null}

      {planState === 'results' && unavailable ? (
        <section className="planner-status planner-status--degraded" role="alert">
          <h3>Pencarian rute belum tersedia</h3>
          <p>Data GTFS atau walk graph belum dimuat di backend. Coba lagi nanti, atau gunakan fitur tracking langsung.</p>
        </section>
      ) : null}

      {planState === 'results' && noRoute ? (
        <section className="planner-status planner-status--empty" role="alert">
          <h3>Tidak ada rute yang tersedia</h3>
          <p>Tidak ditemukan koneksi TransJakarta antara asal dan tujuan. Coba asal atau tujuan lain.</p>
        </section>
      ) : null}

      {planState === 'results' && planResponse && itineraries.length > 0 && selected ? (
        <>
          <section className="itinerary-tabs" aria-label="Pilih alternatif rute">
            {itineraries.map((itinerary, index) => (
              <button
                type="button"
                key={`itinerary-${index}`}
                className={`itinerary-tab${index === selectedItinerary ? ' itinerary-tab--active' : ''}`}
                onClick={() => setSelectedItinerary(index)}
                aria-pressed={index === selectedItinerary}
              >
                <strong>Pilihan {index + 1}</strong>
                <span>{itinerary.total_minutes} mnt · jalan {formatDistance(itinerary.walk_distance_m)}</span>
              </button>
            ))}
          </section>

          <section className="planner-summary" aria-labelledby="planner-summary-heading">
            <p className="eyebrow">RINGKASAN PERJALANAN</p>
            <div className="planner-summary__numbers">
              <div><strong>{selected.total_minutes}</strong><span>menit total</span></div>
              <div><strong>{selected.transfers}</strong><span>transfer</span></div>
              <div><strong>{Math.round(selected.walk_distance_m / 10) / 100}</strong><span>km jalan kaki</span></div>
            </div>
            <p className="planner-summary__note">Estimasi jadwal statis · {planResponse.source === 'gtfs' ? 'sumber GTFS' : 'sumber tidak tersedia'}</p>
          </section>

          <section className="planner-legs" aria-label="Daftar langkah perjalanan">
            <ol className="leg-list">
              {selected.legs.map((leg, index) => (
                <LegRow key={`leg-${index}`} leg={leg} index={index} />
              ))}
            </ol>
          </section>

          <div className="planner-map">
            <MapboxMap stops={plannerStops} routeShapes={planShapes} walkLegs={walkLegs} />
          </div>

          <button className="primary-button planner-track-button" type="button" onClick={startTrackingForChosenRoute}>
            Lanjut ke tracking rute ini <span aria-hidden="true">→</span>
          </button>
        </>
      ) : null}
    </main>
  )
}

export default PlannerPage
