import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ClockField from './ClockField'
import MapboxMap from './MapboxMap'
import type { WalkLine } from './MapboxMap'
import JourneyTrackingPage from './JourneyTrackingPage'
import { ArrowRightIcon, SearchIcon, WalkIcon } from './icons'
import type { Stop } from './journey'
import type { PlanPoint, SavedStop, SearchHistoryEntry } from './plannerStorage'
import type { ProfileType } from './profile'
import { isFacilityStop } from './SideBySidePage'
import type { FacilityStop } from './SideBySidePage'
import StopPickerPage from './StopPickerPage'
import type { TtsProvider } from './tts'
import {
  addHistoryEntry,
  isPlanPoint,
  isRecord,
  persistSavedStops,
  persistSearchHistory,
  readSavedStops,
  readSearchHistory,
  removeSavedStop,
  saveSavedStop,
  savedStopFromPoint,
  savedStopId,
} from './plannerStorage'

interface PlannerPageProps {
  apiBaseUrl: string
  profile?: ProfileType
  tts?: TtsProvider
  onOpenSideBySide?: (stopId: string) => void
  /** Lifts the chosen destination so App.tsx can hand it to the Netra scan screen. */
  onDestinationSelected?: (point: PlanPoint | null) => void
}

interface PlanRouteInfo {
  id: string
  short_name: string
  color?: string
}

export interface PlanLeg {
  mode: 'WALK' | 'BUS' | 'RAIL'
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
  /** ETA origin: live TJ feed, or GTFS schedule fallback. */
  eta_source?: 'scheduled' | 'realtime'
}

export interface PlanItinerary {
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


/** MRT suitability thresholds for the destination userflow (single source of truth). */
const MRT_SUITABILITY = {
  MAX_TRANSFER: 1,
  MAX_MINUTES: 45,
  MAX_WALK_M: 600,
} as const

/** Facility keys surfaced as daksa accessibility chips per BUS stop. */
const DAKSA_CHIP_FACILITIES: ReadonlyArray<{ key: keyof FacilityStop['facilities']; label: string }> = [
  { key: 'ramp', label: 'Ramp' },
  { key: 'lift', label: 'Lift' },
  { key: 'guiding_block', label: 'Guiding block' },
]

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
  const isRailLeg = value.mode === 'RAIL'
  if (!isWalkLeg && !isBusLeg && !isRailLeg) return false
  if (!isPlanPoint(value.from) || !isPlanPoint(value.to)) return false
  if (typeof value.duration_minutes !== 'number' || typeof value.distance_m !== 'number') return false
  if (value.route !== undefined && !isPlanRoute(value.route)) return false
  return (value.headsign === undefined || typeof value.headsign === 'string')
    && (value.trip_id === undefined || typeof value.trip_id === 'string')
    && (value.start_time === undefined || typeof value.start_time === 'string')
    && (value.end_time === undefined || typeof value.end_time === 'string')
    && (value.delay_minutes === undefined || typeof value.delay_minutes === 'number')
    && (value.live_eta_minutes === undefined || typeof value.live_eta_minutes === 'number')
    && (value.eta_source === undefined || value.eta_source === 'scheduled' || value.eta_source === 'realtime')
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
  return { history, recordSearch }
}

/** Facility stop lookup for the daksa accessibility chips (id → stop). */
function buildFacilityIndex(stops: FacilityStop[]): Map<string, FacilityStop> {
  const index = new Map<string, FacilityStop>()
  for (const stop of stops) {
    index.set(stop.id, stop)
  }
  return index
}

/** Chips for one plan point: only when the stop matches a facility stop id. */
function FacilityAccessChips({ stopId, facility, onOpenSideBySide }: { stopId: string; facility: FacilityStop | undefined; onOpenSideBySide?: (stopId: string) => void }) {
  if (!facility) return null
  const available = DAKSA_CHIP_FACILITIES.filter(({ key }) => facility.facilities[key])
  if (available.length === 0) return null
  return (
    <p className="leg__facility-chips">
      {available.map(({ key, label }) => (
        <button
          type="button"
          key={`${stopId}-${key}`}
          className="facility-access-chip"
          onClick={() => onOpenSideBySide?.(stopId)}
          title={`Fasilitas ${label} di ${facility.name} — buka pratinjau side by side`}
        >
          {label}
        </button>
      ))}
    </p>
  )
}

function LegRow({
  leg,
  index,
  affected,
  facilityIndex,
  onOpenSideBySide,
}: {
  leg: PlanLeg
  index: number
  affected: boolean
  facilityIndex: Map<string, FacilityStop>
  onOpenSideBySide?: (stopId: string) => void
}) {
  if (leg.mode === 'WALK') {
    return (
      <li className="leg leg--walk">
        <span className="leg__marker" aria-hidden="true"><WalkIcon size={24} /></span>
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
          LANGKAH {index + 1} · {leg.mode === 'RAIL' ? `NAIK ${leg.route?.short_name ?? 'KERETA'}` : 'NAIK BUS'}
          {affected ? <span className="state-badge state-badge--danger leg__affected-chip">terganggu</span> : null}
        </p>
        <strong>{leg.mode === 'RAIL' ? `${leg.route?.short_name ?? 'Kereta'} · ${leg.headsign ?? 'menuju tujuan'}` : `Koridor ${leg.route?.short_name ?? leg.route?.id ?? 'bus'} · ${leg.headsign ?? 'menuju tujuan'}`}</strong>
        <p className="leg__stops">
          <span>{formatClock(leg.start_time)} naik di {leg.from.name}</span>
          <span aria-hidden="true"><ArrowRightIcon size={16} /></span>
          <span>{formatClock(leg.end_time)} turun di {leg.to.name}</span>
        </p>
        {leg.from.stop_id ? (
          <FacilityAccessChips stopId={leg.from.stop_id} facility={facilityIndex.get(leg.from.stop_id)} onOpenSideBySide={onOpenSideBySide} />
        ) : null}
        {leg.to.stop_id ? (
          <FacilityAccessChips stopId={leg.to.stop_id} facility={facilityIndex.get(leg.to.stop_id)} onOpenSideBySide={onOpenSideBySide} />
        ) : null}
        <p className="leg__meta">{leg.duration_minutes} menit · {formatDistance(leg.distance_m)}</p>
        {leg.live_eta_minutes !== undefined ? (
          <p className="leg__delay" role="status">
            {leg.delay_minutes && leg.delay_minutes > 0 ? (
              <span className="state-badge state-badge--warning">+{leg.delay_minutes} mnt</span>
            ) : null}
            <span className="leg__live-eta">
              {leg.eta_source === 'realtime' ? 'Bus live tiba' : 'Bus berikutnya tiba'} {leg.live_eta_minutes} mnt
            </span>
          </p>
        ) : null}
      </div>
    </li>
  )
}

function PlannerPage({
  apiBaseUrl,
  profile = 'tuli',
  tts,
  onOpenSideBySide,
  onDestinationSelected,
}: PlannerPageProps) {
  const [pickerFor, setPickerFor] = useState<'origin' | 'destination' | null>(null)
  const [origin, setOrigin] = useState<PlanPoint | null>(null)
  const [originFromLocation, setOriginFromLocation] = useState(false)
  const [destination, setDestination] = useState<PlanPoint | null>(null)
  const [selectedDestination, setSelectedDestination] = useState<PlanPoint | null>(null)
  const [facilityStops, setFacilityStops] = useState<FacilityStop[]>([])
  const [planState, setPlanState] = useState<'idle' | 'loading' | 'results' | 'error'>('idle')
  const [planResponse, setPlanResponse] = useState<PlanResponse | null>(null)
  const [planError, setPlanError] = useState('')
  const [selectedItinerary, setSelectedItinerary] = useState(0)
  const [planShapes, setPlanShapes] = useState<PlannerShape[]>([])
  const [walkLegs, setWalkLegs] = useState<WalkLine[]>([])
  const [phase, setPhase] = useState<PlannerPhase>('plan')

  // Departure is an optional clock input (24-hour "HH:MM") that anchors the
  // forward plan (`time`); empty means "leave as soon as possible".
  const [departureTime, setDepartureTime] = useState('')

  const { savedStops, addSavedStop, removeSavedStop: removeStoredStop } = useSavedStops()
  const { history, recordSearch } = useSearchHistory()

  const openPicker = (kind: 'origin' | 'destination') => {
    if (profile === 'netra') tts?.speak(kind === 'origin' ? 'Pilih titik asal' : 'Pilih titik tujuan')
    setPickerFor(kind)
  }

  const pickPoint = (kind: 'origin' | 'destination', point: PlanPoint, viaLocation = false) => {
    if (kind === 'origin') {
      setOrigin(point)
      setOriginFromLocation(viaLocation)
    } else {
      setDestination(point)
      setSelectedDestination(point)
    }
    resetPlanResults()
    setPickerFor(null)
  }

  const toggleFavorite = (point: PlanPoint) => {
    const id = savedStopId(point)
    if (savedStops.some((stop) => stop.id === id)) {
      removeStoredStop(id)
      return
    }
    addSavedStop(savedStopFromPoint(point, point.name))
  }

  const resetPlanResults = () => {
    setPlanState('idle')
    setPlanResponse(null)
    setPlanError('')
    setSelectedItinerary(0)
    setPlanShapes([])
    setWalkLegs([])
  }

  // Daksa accessibility chips: fetch the facility stops once after plan
  // results load and cache them in state (a successful load never refetches;
  // an interrupted one may retry on the next results render). A missing or
  // failed fetch just means no chips — the flow never blocks on it.
  const facilityStopsLoadedRef = useRef(false)
  useEffect(() => {
    if (profile !== 'daksa' || planState !== 'results' || facilityStopsLoadedRef.current) return
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/facilities/stops`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return
        const payload = (await response.json()) as { stops?: unknown }
        const loaded = Array.isArray(payload.stops) ? payload.stops.filter(isFacilityStop) : []
        if (!controller.signal.aborted) {
          facilityStopsLoadedRef.current = true
          setFacilityStops(loaded)
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn('Facility stops lookup failed.', error)
      })
    return () => controller.abort()
  }, [profile, planState, apiBaseUrl])

  const facilityIndex = useMemo(() => buildFacilityIndex(facilityStops), [facilityStops])

  // Keep the parent (App.tsx) informed of the chosen destination so the
  // netra-scan screen can receive it as station context (wired in T6).
  useEffect(() => {
    onDestinationSelected?.(selectedDestination)
  }, [selectedDestination, onDestinationSelected])

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

    // Optional departure clock anchors the forward plan (`time`); absent =
    // "leave as soon as possible" (backend defaults to now).
    if (departureTime) params.set('time', departureTime)
    // Always request ETA metadata so delay badges render whenever the
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
              shapes.push({ id: leg.route.id, name: leg.route.short_name, color: leg.route.color ?? 'var(--brand-color-accent)', coordinates: data.coordinates })
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
      <JourneyTrackingPage
        apiBaseUrl={apiBaseUrl}
        itinerary={trackingItinerary}
        onBack={() => setPhase('plan')}
      />
    )
  }

  if (pickerFor) {
    return (
      <StopPickerPage
        apiBaseUrl={apiBaseUrl}
        kind={pickerFor}
        savedStops={savedStops}
        history={history}
        profile={profile}
        tts={tts}
        onPick={(point, meta) => pickPoint(pickerFor, point, meta?.viaLocation)}
        onToggleFavorite={toggleFavorite}
        onBack={() => setPickerFor(null)}
      />
    )
  }

  const itineraries = planResponse?.itineraries ?? []
  const selected = planResponse?.itineraries[selectedItinerary] ?? null
  const unavailable = planResponse?.source === 'unavailable'
  const noRoute = planResponse?.source === 'gtfs' && itineraries.length === 0
  // MRT suitability userflow: evaluated on the FIRST (fastest) itinerary from
  // every result set (manual search, history, saved stops alike).
  const firstItinerary = itineraries.length > 0 ? itineraries[0] : null
  const mrtSuitable = planState === 'results' && !!firstItinerary
    && firstItinerary.transfers <= MRT_SUITABILITY.MAX_TRANSFER
    && firstItinerary.total_minutes <= MRT_SUITABILITY.MAX_MINUTES
    && (firstItinerary.walk_distance_m ?? 0) <= MRT_SUITABILITY.MAX_WALK_M

  return (
    <main className="page-content inner-page planner-page">
      <section className="page-intro">
        <p className="eyebrow">ANTAR AKU / PERENCANA RUTE</p>
        <h2>Cari rute TransJakarta</h2>
        <p>Masukkan asal dan tujuan, lalu pilih rute terbaik. Setelah memilih, kamu bisa mengikuti armada secara langsung.</p>
      </section>

      <form className="planner-form" onSubmit={(event) => { void runPlan(event) }}>
        <div className="planner-field">
          <span className="planner-field__label" id="planner-from-label">Dari</span>
          <button type="button" className="planner-point-btn" onClick={() => openPicker('origin')} aria-labelledby="planner-from-label">
            <span className="planner-point-btn__value">{origin ? origin.name : 'Pilih titik asal'}</span>
            <span className="planner-point-btn__action" aria-hidden="true"><SearchIcon size={18} /> {origin ? 'Ganti' : 'Cari'}</span>
          </button>
          {originFromLocation && origin ? (
            <p className="planner-locate-note">Asal: {origin.name} (dari lokasimu)</p>
          ) : null}
        </div>
        <div className="planner-field">
          <span className="planner-field__label" id="planner-to-label">Ke</span>
          <button type="button" className="planner-point-btn" onClick={() => openPicker('destination')} aria-labelledby="planner-to-label">
            <span className="planner-point-btn__value">{destination ? destination.name : 'Pilih titik tujuan'}</span>
            <span className="planner-point-btn__action" aria-hidden="true"><SearchIcon size={18} /> {destination ? 'Ganti' : 'Cari'}</span>
          </button>
        </div>
        <div className="planner-time-controls" role="group" aria-label="Waktu perjalanan">
          <div className="planner-field">
            <span className="planner-field__label">Berangkat jam</span>
            <ClockField
              label="jam berangkat"
              value={departureTime}
              onChange={setDepartureTime}
            />
          </div>
        </div>
        <button
          className={`primary-button${profile === 'netra' ? ' planner-btn--netra' : ''}`}
          type="submit"
          disabled={planState === 'loading'}
          onClick={() => { if (profile === 'netra') tts?.speak('Cari rute') }}
        >
          {planState === 'loading' ? 'Mencari rute…' : 'Cari rute'} <span aria-hidden="true"><ArrowRightIcon size={20} /></span>
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

          {mrtSuitable ? (
            <div className="mrt-suitability-banner" role="status">
              <strong>Rute MRT tersedia dan efektif</strong>
              <span>Perjalanan {firstItinerary?.total_minutes ?? 0} menit · {firstItinerary?.transfers ?? 0} transfer · jalan kaki {formatDistance(firstItinerary?.walk_distance_m ?? 0)} — aman untuk MRT.</span>
            </div>
          ) : (
            <div className="mrt-suitability-notice" role="status">
              <strong>Tujuan agak jauh kalau pakai MRT.</strong>
              <span>Kami sarankan menggunakan transportasi darat lain. Rute di bawah tetap tersedia sebagai informasi.</span>
            </div>
          )}

          <section className="planner-summary" aria-labelledby="planner-summary-heading">
            <p className="eyebrow">RINGKASAN PERJALANAN</p>
            {departureTime && selected.legs[0] ? (
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
                  facilityIndex={facilityIndex}
                  onOpenSideBySide={onOpenSideBySide}
                />
              ))}
            </ol>
          </section>

          <div className="planner-map">
            <MapboxMap stops={plannerStops} routeShapes={planShapes} walkLegs={walkLegs} />
          </div>

          <button
            className={`primary-button planner-track-button${mrtSuitable ? ' planner-track-button--highlight' : ' planner-track-button--deemphasized'}${profile === 'netra' ? ' planner-btn--netra' : ''}`}
            type="button"
            onClick={() => { if (profile === 'netra') tts?.speak('Lanjut ke tracking rute ini'); startTrackingForChosenRoute() }}
          >
            Lanjut ke tracking rute ini <span aria-hidden="true"><ArrowRightIcon size={20} /></span>
          </button>
        </>
      ) : null}
    </main>
  )
}

export default PlannerPage
