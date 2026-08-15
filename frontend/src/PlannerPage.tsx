import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import MapboxMap from './MapboxMap'
import type { WalkLine } from './MapboxMap'
import type { Stop } from './journey'
import type { PlanPoint, SavedStop, SearchHistoryEntry } from './plannerStorage'
import {
  addHistoryEntry,
  isPlanPoint,
  isRecord,
  persistSavedStops,
  persistSearchHistory,
  pointFromSavedStop,
  readSavedStops,
  readSearchHistory,
  removeHistoryEntry,
  removeSavedStop,
  saveSavedStop,
  savedStopFromPoint,
} from './plannerStorage'

interface PlannerPageProps {
  apiBaseUrl: string
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
  /** Delay (minutes) reported for this leg's trip when the backend sends ETA data (`include_eta=1`). */
  delay_minutes?: number
  /** Live/estimated arrival (minutes) when the backend sends ETA data. */
  live_eta_minutes?: number
  /** Origin of `delay_minutes`: deterministic schedule estimate or live feed. */
  eta_source?: 'simulated' | 'realtime'
}

interface PlanItinerary {
  legs: PlanLeg[]
  transfers: number
  walk_distance_m: number
  walk_minutes?: number
  waiting_minutes?: number
  total_minutes: number
}

interface PlanIncident {
  route_id?: string
  status: 'delay' | 'diverted'
  cause?: string
  action?: string
  instruction?: string
  updated_at?: string
  id?: string
}

interface PlanResponse {
  itineraries: PlanItinerary[]
  source: 'gtfs' | 'unavailable'
  /** Active service disruptions returned beside the itineraries; absent on older responses. */
  incidents?: PlanIncident[]
}

interface PlannerShape {
  id: string
  name: string
  color: string
  coordinates: [number, number][]
}

type PlannerPhase = 'plan' | 'tracking'

function SimulatedTrackingPage({
  itinerary,
  planShapes,
  walkLegs,
  onBack,
}: {
  itinerary: PlanItinerary
  planShapes: PlannerShape[]
  walkLegs: WalkLine[]
  onBack: () => void
}) {
  const [checkpointIndex, setCheckpointIndex] = useState(0)
  const [mapOpen, setMapOpen] = useState(false)

  const checkpoints = useMemo(() => {
    const result: { id: string; name: string; mode: PlanLeg['mode']; route?: string }[] = []
    for (const leg of itinerary.legs) {
      const point = leg.from
      const id = point.stop_id ?? `${point.name}:${point.lat},${point.lng}`
      if (!result.some((item) => item.id === id)) {
        result.push({ id, name: point.name, mode: leg.mode, route: leg.route?.short_name })
      }
      const destination = leg.to
      const destinationId = destination.stop_id ?? `${destination.name}:${destination.lat},${destination.lng}`
      if (!result.some((item) => item.id === destinationId)) {
        result.push({ id: destinationId, name: destination.name, mode: leg.mode, route: leg.route?.short_name })
      }
    }
    return result
  }, [itinerary])

  const current = checkpoints[checkpointIndex]
  const next = checkpoints[checkpointIndex + 1]
  const progress = checkpoints.length <= 1 ? 100 : Math.round((checkpointIndex / (checkpoints.length - 1)) * 100)
  const mapStops: Stop[] = checkpoints.map((checkpoint, index) => {
    const point = itinerary.legs.flatMap((leg) => [leg.from, leg.to]).find((candidate) => {
      const id = candidate.stop_id ?? `${candidate.name}:${candidate.lat},${candidate.lng}`
      return id === checkpoint.id
    })
    return { id: checkpoint.id, name: `${index === checkpointIndex ? 'SEKARANG · ' : ''}${checkpoint.name}`, lat: point?.lat ?? 0, lng: point?.lng ?? 0 }
  }).filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lng) && stop.lat !== 0)

  return (
    <main className="page-content inner-page planner-page planner-simulation-page">
      <section className="planner-simulation__header">
        <button type="button" className="schedule-detail__back" onClick={onBack}>← Kembali ke rute</button>
        <p className="eyebrow">SIMULASI PER HALTE</p>
        <h2>Perjalanan aktif</h2>
        <p>Gunakan tombol halte berikutnya untuk mensimulasikan posisi perjalanan.</p>
      </section>

      <section className="planner-simulation__status" aria-live="polite">
        <p className="eyebrow">SEKARANG</p>
        <h3>{current?.name ?? 'Perjalanan selesai'}</h3>
        {current?.route ? <span className="state-badge state-badge--safe">BUS {current.route}</span> : null}
        <div className="planner-simulation__progress"><span style={{ width: `${progress}%` }} /></div>
        <p className="planner-simulation__progress-label">{progress}% perjalanan · {next ? `${checkpoints.length - checkpointIndex - 1} titik tersisa` : 'Tujuan tercapai'}</p>
      </section>

      <section className="planner-simulation__next">
        <p className="eyebrow">BERIKUTNYA</p>
        <strong>{next?.name ?? 'Selesai'}</strong>
        <span>{next ? `Naik/lanjut dengan ${next.mode === 'BUS' ? `bus ${next.route ?? ''}` : 'jalan kaki'}` : 'Kamu sudah sampai tujuan.'}</span>
        <button className="primary-button" type="button" disabled={!next} onClick={() => setCheckpointIndex((index) => Math.min(index + 1, checkpoints.length - 1))}>
          {next ? 'Halte berikutnya' : 'Perjalanan selesai'} <span aria-hidden="true">→</span>
        </button>
      </section>

      <button className="planner-map-dropdown__toggle" type="button" aria-expanded={mapOpen} onClick={() => setMapOpen((open) => !open)}>
        {mapOpen ? 'Sembunyikan peta' : 'Lihat peta perjalanan'} <span aria-hidden="true">{mapOpen ? '▲' : '▼'}</span>
      </button>
      {mapOpen ? (
        <section className="planner-map-dropdown" aria-label="Peta perjalanan simulasi">
          <MapboxMap stops={mapStops} routeShapes={planShapes} walkLegs={walkLegs} />
        </section>
      ) : null}

      <section className="planner-simulation__timeline" aria-label="Urutan halte perjalanan">
        <p className="eyebrow">URUTAN PERJALANAN</p>
        <ol>
          {checkpoints.map((checkpoint, index) => (
            <li className={index < checkpointIndex ? 'is-complete' : index === checkpointIndex ? 'is-current' : ''} key={checkpoint.id}>
              <span className="planner-simulation__dot" />
              <span>{checkpoint.name}</span>
              {index === checkpointIndex ? <small>SEKARANG</small> : index === checkpointIndex + 1 ? <small>BERIKUTNYA</small> : null}
            </li>
          ))}
        </ol>
      </section>
    </main>
  )
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
    && (value.delay_minutes === undefined || typeof value.delay_minutes === 'number')
    && (value.live_eta_minutes === undefined || typeof value.live_eta_minutes === 'number')
    && (value.eta_source === undefined || value.eta_source === 'simulated' || value.eta_source === 'realtime')
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

function isPlanIncident(value: unknown): value is PlanIncident {
  if (!isRecord(value)) return false
  return typeof value.status === 'string'
    && (value.route_id === undefined || typeof value.route_id === 'string')
    && (value.cause === undefined || typeof value.cause === 'string')
    && (value.action === undefined || typeof value.action === 'string')
    && (value.instruction === undefined || typeof value.instruction === 'string')
    && (value.updated_at === undefined || typeof value.updated_at === 'string')
    && (value.id === undefined || typeof value.id === 'string')
}

function isPlanResponse(value: unknown): value is PlanResponse {
  if (!isRecord(value)) return false
  return Array.isArray(value.itineraries)
    && value.itineraries.every(isPlanItinerary)
    && (value.source === 'gtfs' || value.source === 'unavailable')
    && (value.incidents === undefined
      || (Array.isArray(value.incidents) && value.incidents.every(isPlanIncident)))
}

function incidentStatusLabel(status: string): string {
  if (status === 'delay') return 'Keterlambatan'
  if (status === 'diverted') return 'Pengalihan'
  return status
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

function formatHistoryTime(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function useSavedStops() {
  const [savedStops, setSavedStops] = useState<SavedStop[]>(() => readSavedStops())
  const addSavedStop = (item: SavedStop) => {
    setSavedStops((current) => {
      const next = saveSavedStop(current, item)
      persistSavedStops(next)
      return next
    })
  }
  const removeStoredStop = (id: string) => {
    setSavedStops((current) => {
      const next = removeSavedStop(current, id)
      persistSavedStops(next)
      return next
    })
  }
  return { savedStops, addSavedStop, removeSavedStop: removeStoredStop }
}

function useSearchHistory() {
  const [history, setHistory] = useState<SearchHistoryEntry[]>(() => readSearchHistory())
  const recordSearch = (origin: PlanPoint, destination: PlanPoint, at = new Date().toISOString()) => {
    setHistory((current) => {
      const next = addHistoryEntry(current, { origin, destination, at })
      persistSearchHistory(next)
      return next
    })
  }
  const removeStoredEntry = (at: string) => {
    setHistory((current) => {
      const next = removeHistoryEntry(current, at)
      persistSearchHistory(next)
      return next
    })
  }
  return { history, recordSearch, removeHistoryEntry: removeStoredEntry }
}

function LegRow({ leg, index, affected }: { leg: PlanLeg; index: number; affected: boolean }) {
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
        <p className="leg__eyebrow">
          LANGKAH {index + 1} · NAIK BUS
          {affected ? <span className="state-badge state-badge--danger leg__affected-chip">terganggu</span> : null}
        </p>
        <strong>Koridor {leg.route?.short_name ?? leg.route?.id ?? 'bus'} · {leg.headsign ?? 'menuju tujuan'}</strong>
        <p className="leg__stops">
          <span>{formatClock(leg.start_time)} naik di {leg.from.name}</span>
          <span aria-hidden="true">→</span>
          <span>{formatClock(leg.end_time)} turun di {leg.to.name}</span>
        </p>
        <p className="leg__meta">{leg.duration_minutes} menit · {formatDistance(leg.distance_m)}</p>
        {leg.delay_minutes && leg.delay_minutes > 0 ? (
          <p className="leg__delay" role="status">
            <span className="state-badge state-badge--warning">+{leg.delay_minutes} mnt</span>
            {leg.eta_source === 'simulated' ? <small className="leg__eta-source">simulasi</small> : null}
            {leg.live_eta_minutes !== undefined ? <span className="leg__live-eta">ETA langsung {leg.live_eta_minutes} mnt</span> : null}
          </p>
        ) : leg.live_eta_minutes !== undefined ? (
          <p className="leg__delay" role="status">
            <span className="leg__live-eta">ETA langsung {leg.live_eta_minutes} mnt</span>
          </p>
        ) : null}
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

  // Departure vs arrive-by planning. Default = "Berangkat jam" (backward
  // compatible: sends `time`). Toggle on = "Tiba jam": sends `arrive_by` and
  // the backend plans a latest departure that still arrives by that clock.
  const [arriveByMode, setArriveByMode] = useState(false)
  const [travelTime, setTravelTime] = useState(() => new Date().toTimeString().slice(0, 5))

  const { savedStops, addSavedStop, removeSavedStop: removeStoredStop } = useSavedStops()
  const { history, recordSearch, removeHistoryEntry: removeStoredHistoryEntry } = useSearchHistory()
  const [saveTarget, setSaveTarget] = useState<'origin' | 'destination' | null>(null)
  const [saveLabel, setSaveLabel] = useState('')
  const [historyOpen, setHistoryOpen] = useState(true)

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

  const resetPlanResults = () => {
    setPlanState('idle')
    setPlanResponse(null)
    setPlanError('')
    setSelectedItinerary(0)
    setPlanShapes([])
    setWalkLegs([])
  }

  const beginSaveStop = (kind: 'origin' | 'destination') => {
    const point = kind === 'origin' ? origin : destination
    if (!point) return
    setSaveLabel(point.name)
    setSaveTarget(kind)
  }

  const cancelSaveStop = () => {
    setSaveTarget(null)
    setSaveLabel('')
  }

  const confirmSaveStop = () => {
    if (!saveTarget) return
    const point = saveTarget === 'origin' ? origin : destination
    if (!point) return
    addSavedStop(savedStopFromPoint(point, saveLabel))
    cancelSaveStop()
  }

  const fillSavedStop = (stop: SavedStop, kind: 'origin' | 'destination') => {
    choosePoint(kind, pointFromSavedStop(stop))
    resetPlanResults()
  }

  const fillFromHistory = (entry: SearchHistoryEntry) => {
    choosePoint('origin', entry.origin)
    choosePoint('destination', entry.destination)
    resetPlanResults()
  }

  const executePlan = async (from: PlanPoint | null = origin, to: PlanPoint | null = destination) => {
    if (!from) {
      setPlanState('error')
      setPlanError('Pilih titik asal dari saran halte dulu.')
      return
    }
    if (!to) {
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
    if (from.stop_id) {
      params.set('from_stop', from.stop_id)
    } else {
      params.set('from_lat', String(from.lat))
      params.set('from_lng', String(from.lng))
    }
    if (to.stop_id) {
      params.set('to_stop', to.stop_id)
    } else {
      params.set('to_lat', String(to.lat))
      params.set('to_lng', String(to.lng))
    }

    // Departure vs arrive-by: when the toggle is ON ("Tiba jam") we send only
    // `arrive_by`; when OFF ("Berangkat jam") we send only `time` (the original
    // departure param, backward compatible). Never both at once.
    if (travelTime) {
      if (arriveByMode) params.set('arrive_by', travelTime)
      else params.set('time', travelTime)
    }
    // Always request ETA metadata so the demo renders delay badges whenever the
    // backend has them (`delay_minutes` / `live_eta_minutes` / `eta_source`).
    params.set('include_eta', '1')

    try {
      const response = await fetch(`${apiBaseUrl}/api/journey/plan?${params}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      // Record this successful plan (HTTP 200) in the local search history,
      // regardless of itinerary count. Consecutive duplicates are merged into
      // one entry and moved to the top by addHistoryEntry.
      recordSearch(from, to)
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

  const runPlan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await executePlan()
  }

  const runDemo = async () => {
    const jis: PlanPoint = { stop_id: 'H00273P', name: 'Jakarta International Stadium', lat: -6.125, lng: 106.858 }
    const blokM: PlanPoint = { stop_id: 'B02860P', name: 'Plaza Blok M', lat: -6.244, lng: 106.798 }
    choosePoint('origin', jis)
    choosePoint('destination', blokM)
    setPhase('plan')
    await executePlan(jis, blokM)
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

  const affectedRouteIds = useMemo(() => {
    const ids = new Set<string>()
    for (const incident of planResponse?.incidents ?? []) {
      if (incident.route_id) ids.add(incident.route_id)
    }
    return ids
  }, [planResponse])

  const startTrackingForChosenRoute = () => {
    const itinerary = planResponse?.itineraries[selectedItinerary]
    if (!itinerary) return
    setPhase('tracking')
  }

  const trackingItinerary = planResponse?.itineraries[selectedItinerary] ?? null
  if (phase === 'tracking' && trackingItinerary) {
    return (
      <SimulatedTrackingPage
        itinerary={trackingItinerary}
        planShapes={planShapes}
        walkLegs={walkLegs}
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
        <button className="secondary-button demo-route-btn" type="button" onClick={() => { void runDemo() }} disabled={planState === 'loading'}>
          Demo: JIS → Blok M
        </button>
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
        <div className="planner-time-controls" role="group" aria-label="Waktu perjalanan">
          <div className="planner-time-toggle" role="radiogroup" aria-label="Mode waktu">
            <button
              type="button"
              className={`planner-time-toggle__option${arriveByMode ? '' : ' planner-time-toggle__option--active'}`}
              aria-pressed={!arriveByMode}
              onClick={() => setArriveByMode(false)}
            >
              Berangkat jam
            </button>
            <button
              type="button"
              className={`planner-time-toggle__option${arriveByMode ? ' planner-time-toggle__option--active' : ''}`}
              aria-pressed={arriveByMode}
              onClick={() => setArriveByMode(true)}
            >
              Tiba jam
            </button>
          </div>
          <label className="planner-field">
            <span className="planner-field__label">{arriveByMode ? 'Tiba jam' : 'Berangkat jam'}</span>
            <input
              type="time"
              value={travelTime}
              onChange={(event) => setTravelTime(event.target.value)}
            />
          </label>
        </div>
        <button className="primary-button" type="submit" disabled={planState === 'loading'}>
          {planState === 'loading' ? 'Mencari rute…' : 'Cari rute'} <span aria-hidden="true">→</span>
        </button>
      </form>

      <section className="saved-stops-section" aria-labelledby="saved-stops-heading">
        <div>
          <p className="eyebrow">HALTE FAVORIT</p>
          <h3 id="saved-stops-heading">Halte favorit</h3>
        </div>

        {saveTarget !== null ? (
          <div className="saved-stop-editor" role="group" aria-labelledby="saved-stop-editor-heading">
            <p className="eyebrow" id="saved-stop-editor-heading">
              Simpan {saveTarget === 'origin' ? 'asal' : 'tujuan'} · {(saveTarget === 'origin' ? origin : destination)?.name}
            </p>
            <label className="planner-field" htmlFor="saved-stop-name">
              <span className="planner-field__label">Nama favorit</span>
              <input
                id="saved-stop-name"
                value={saveLabel}
                onChange={(event) => setSaveLabel(event.target.value)}
                placeholder="Mis. kantor, rumah, sekolah"
                autoComplete="off"
              />
            </label>
            <div className="saved-stop-editor__actions">
              <button className="primary-button" type="button" onClick={confirmSaveStop}>Simpan</button>
              <button className="secondary-button" type="button" onClick={cancelSaveStop}>Batal</button>
            </div>
          </div>
        ) : origin || destination ? (
          <div className="saved-stop-actions">
            {origin ? (
              <button type="button" className="secondary-button" onClick={() => beginSaveStop('origin')}>
                Simpan asal sebagai favorit <span aria-hidden="true">★</span>
              </button>
            ) : null}
            {destination ? (
              <button type="button" className="secondary-button" onClick={() => beginSaveStop('destination')}>
                Simpan tujuan sebagai favorit <span aria-hidden="true">★</span>
              </button>
            ) : null}
          </div>
        ) : null}

        {savedStops.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__mark" aria-hidden="true">☆</span>
            <h3>Belum ada halte favorit</h3>
            <p>Pilih asal atau tujuan, lalu simpan sebagai favorit untuk pencarian yang lebih cepat.</p>
          </div>
        ) : (
          <ul className="saved-stops-list">
            {savedStops.map((stop) => (
              <li key={stop.id} className="saved-stop-item">
                <span className="saved-stop-item__mark" aria-hidden="true">★</span>
                <div className="saved-stop-item__body">
                  <strong>{stop.name}</strong>
                  {stop.stopName !== stop.name ? <span>{stop.stopName}</span> : null}
                </div>
                <div className="saved-stop-item__actions">
                  <button type="button" className="saved-stop-item__target" onClick={() => fillSavedStop(stop, 'origin')}>Dari</button>
                  <button type="button" className="saved-stop-item__target" onClick={() => fillSavedStop(stop, 'destination')}>Ke</button>
                  <button type="button" className="saved-stop-item__delete" aria-label={`Hapus favorit ${stop.name}`} onClick={() => removeStoredStop(stop.id)}>×</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="search-history-section" aria-labelledby="search-history-heading">
        <div className="search-history-section__head">
          <div>
            <p className="eyebrow">RIWAYAT PENCARIAN</p>
            <h3 id="search-history-heading">Riwayat pencarian</h3>
          </div>
          <button
            type="button"
            className="secondary-button search-history-section__toggle"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
            aria-controls="search-history-list"
          >
            {historyOpen ? 'Sembunyikan' : 'Tampilkan'} <span aria-hidden="true">{historyOpen ? '▲' : '▼'}</span>
          </button>
        </div>

        {historyOpen ? (
          history.length === 0 ? (
            <div className="empty-state">
              <span className="empty-state__mark" aria-hidden="true">⌕</span>
              <h3>Belum ada riwayat pencarian</h3>
              <p>Rute yang berhasil dicari akan muncul di sini agar bisa dipakai lagi dengan cepat.</p>
            </div>
          ) : (
            <ul id="search-history-list" className="history-list">
              {history.map((entry) => (
                <li key={entry.at} className="history-item">
                  <button type="button" className="history-item__fill" onClick={() => fillFromHistory(entry)}>
                    <strong>{entry.origin.name} <span aria-hidden="true">→</span> {entry.destination.name}</strong>
                    <span>{formatHistoryTime(entry.at)}</span>
                  </button>
                  <button type="button" className="history-item__delete" aria-label={`Hapus riwayat ${entry.origin.name} ke ${entry.destination.name}`} onClick={() => removeStoredHistoryEntry(entry.at)}>×</button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>

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

      {planState === 'results' && planResponse?.incidents && planResponse.incidents.length > 0 ? (
        <section className="planner-incidents" aria-labelledby="planner-incidents-heading">
          <div className="planner-incidents__head">
            <p className="eyebrow">GANGGUAN LAYANAN</p>
            <h3 id="planner-incidents-heading">Ada gangguan di perjalananmu</h3>
          </div>
          <ul className="incident-list">
            {planResponse.incidents.map((incident, index) => (
              <li key={incident.id ?? `planner-incident-${index}`}>
                <article className="incident-card">
                  <div className="incident-card__header">
                    <span className="state-badge state-badge--danger">GANGGUAN</span>
                    <span>{incident.route_id ? `Koridor ${incident.route_id}` : 'Rute terpengaruh'}</span>
                  </div>
                  <h3>{incidentStatusLabel(incident.status)}</h3>
                  <dl className="incident-details">
                    {incident.cause ? <div><dt>Penyebab</dt><dd>{incident.cause}</dd></div> : null}
                    {incident.action ? <div><dt>Tindakan</dt><dd>{incident.action}</dd></div> : null}
                    {incident.instruction ? <div><dt>Instruksi</dt><dd>{incident.instruction}</dd></div> : null}
                  </dl>
                </article>
              </li>
            ))}
          </ul>
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
            {arriveByMode && selected.legs[0] ? (
              <p className="planner-summary__departure" role="status">
                <span>Berangkat pukul</span>
                <strong>{formatClock(selected.legs[0].start_time)}</strong>
                <span>dari {selected.legs[0].from.name}</span>
              </p>
            ) : null}
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
                <LegRow
                  key={`leg-${index}`}
                  leg={leg}
                  index={index}
                  affected={leg.mode === 'BUS' && !!leg.route && (affectedRouteIds.has(leg.route.id) || affectedRouteIds.has(leg.route.short_name))}
                />
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
