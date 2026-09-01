import { useCallback, useEffect, useRef, useState } from 'react'
import MapboxMap from './MapboxMap'
import type { Stop } from './journey'
import { VIBRATION_PATTERNS } from './journey'
import { ArrowBackIcon, ArrowRightIcon, BusIcon, StopIcon, WalkIcon } from './icons'
import { vibrate } from './haptics'
import type { PlanItinerary, PlanLeg } from './PlannerPage'

/**
 * Real journey tracking (Tuli-first: visual + haptic + edge-flash, no audio).
 *
 * The user waits at the boarding stop while the vehicle's real ETA/position is
 * polled (bus: TJ realtime `/api/arrivals`; MRT: schedule simulation
 * `/api/transit/positions`).  The user's GPS advances the itinerary leg by leg
 * (walk legs complete when the user reaches the next point; transit legs board
 * when the user is at the boarding stop and alight when the user nears the
 * destination stop).
 */

interface Arrival {
  bus_id: string
  route_code: string
  headsign: string
  eta_minutes: number
  eta_source: 'realtime' | 'scheduled' | 'estimated'
  distance_km: number
  lat: number
  lng: number
}

interface TrainPosition {
  id: string
  direction: string
  lat: number
  lng: number
  next_station: string | null
  progress_pct: number
}

export interface JourneyTrackingPageProps {
  apiBaseUrl: string
  itinerary: PlanItinerary
  onBack: () => void
}

type LegPhase = 'awaiting' | 'onboard' | 'arrived'

interface LatLng {
  lat: number
  lng: number
}

const ARRIVED_M = 100
const APPROACHING_M = 500

function haversineM(a: LatLng, b: LatLng): number {
  const radius = 6371008.8
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * radius * Math.asin(Math.sqrt(s))
}

export default function JourneyTrackingPage({ apiBaseUrl, itinerary, onBack }: JourneyTrackingPageProps) {
  const [legIndex, setLegIndex] = useState(0)
  const [legPhase, setLegPhase] = useState<LegPhase>('awaiting')
  const [userPos, setUserPos] = useState<LatLng | null>(null)
  const [gpsUnavailable, setGpsUnavailable] = useState(false)
  const [nextArrival, setNextArrival] = useState<Arrival | null>(null)
  const [trains, setTrains] = useState<TrainPosition[]>([])
  const [arrivalUnavailable, setArrivalUnavailable] = useState(false)
  const approachingNotified = useRef(false)
  const etaNotified = useRef(false)

  const leg: PlanLeg | undefined = itinerary.legs[legIndex]
  const isLast = legIndex >= itinerary.legs.length - 1

  // Track the user's GPS position.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGpsUnavailable(true)
      return
    }
    const id = navigator.geolocation.watchPosition(
      (position) => setUserPos({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setGpsUnavailable(true),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  // Poll the vehicle ETA/position for the current transit leg (every 15 s).
  useEffect(() => {
    if (!leg || leg.mode === 'WALK') return
    let cancelled = false
    const poll = async () => {
      try {
        if (leg.mode === 'BUS') {
          const stopId = leg.from.stop_id
          if (!stopId) return
          const url = `${apiBaseUrl}/api/arrivals?stop_id=${encodeURIComponent(stopId)}&route_code=${encodeURIComponent(leg.route?.short_name ?? '')}`
          const response = await fetch(url)
          const data = (await response.json()) as { arrivals: Arrival[] }
          if (cancelled) return
          setNextArrival(data.arrivals?.[0] ?? null)
          setArrivalUnavailable(false)
        } else {
          const railKey = leg.route?.id ?? 'MRTJ:M'
          const [operator, code] = railKey.split(':')
          const response = await fetch(`${apiBaseUrl}/api/transit/positions?operator=${encodeURIComponent(operator ?? 'MRTJ')}&code=${encodeURIComponent(code ?? 'M')}`)
          const data = (await response.json()) as { source: string; trains: TrainPosition[] }
          if (cancelled) return
          setTrains(data.trains ?? [])
          setArrivalUnavailable(data.source !== 'scheduled')
        }
      } catch {
        if (!cancelled) setArrivalUnavailable(true)
      }
    }
    void poll()
    const timer = window.setInterval(poll, 15000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [apiBaseUrl, leg])

  const advanceLeg = useCallback(() => {
    if (isLast) {
      setLegPhase('arrived')
      return
    }
    setLegIndex((index) => index + 1)
    setLegPhase('awaiting')
    setNextArrival(null)
    setTrains([])
    approachingNotified.current = false
    etaNotified.current = false
  }, [isLast])

  const boardLeg = useCallback(() => {
    setLegPhase('onboard')
  }, [])

  // Geofence: walk legs complete on arrival; transit legs alight on arrival.
  useEffect(() => {
    if (!leg || !userPos) return
    const distanceTo = haversineM(userPos, { lat: leg.to.lat, lng: leg.to.lng })
    if (distanceTo < ARRIVED_M) {
      advanceLeg()
      return
    }
    if (legPhase === 'onboard' && distanceTo < APPROACHING_M) {
      if (!approachingNotified.current) {
        approachingNotified.current = true
        vibrate(VIBRATION_PATTERNS.destinationApproaching)
      }
    }
  }, [userPos, leg, legPhase, advanceLeg])

  // Haptic cue when the bus is about to arrive at the boarding stop.
  useEffect(() => {
    if (leg?.mode === 'BUS' && legPhase === 'awaiting' && nextArrival && nextArrival.eta_minutes <= 5) {
      if (!etaNotified.current) {
        etaNotified.current = true
        vibrate(VIBRATION_PATTERNS.vehicleApproaching)
      }
    }
  }, [leg, legPhase, nextArrival])

  const boardReady =
    !!userPos && !!leg && leg.mode !== 'WALK' && haversineM(userPos, { lat: leg.from.lat, lng: leg.from.lng }) < ARRIVED_M

  const mapStops: Stop[] = (itinerary.legs ?? [])
    .flatMap((item) => [item.from, item.to])
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat !== 0)
    .map((point, index) => ({
      id: point.stop_id ?? `pt-${index}`,
      name: `${index === legIndex * 2 ? 'SEKARANG · ' : ''}${point.name}`,
      lat: point.lat,
      lng: point.lng,
    }))

  const mapBuses: Array<{ id: string; route_code: string; lat: number; lng: number; observed_at: string }> = []
  if (nextArrival) {
    mapBuses.push({ id: nextArrival.bus_id, route_code: nextArrival.route_code, lat: nextArrival.lat, lng: nextArrival.lng, observed_at: new Date().toISOString() })
  } else if (trains.length > 0) {
    const train = trains[0]
    mapBuses.push({ id: train.id, route_code: leg.route?.short_name ?? 'RAIL', lat: train.lat, lng: train.lng, observed_at: new Date().toISOString() })
  }

  const isApproaching = legPhase === 'onboard' && !!userPos && !!leg && haversineM(userPos, { lat: leg.to.lat, lng: leg.to.lng }) < APPROACHING_M
  const isArrived = legPhase === 'arrived'

  const renderLegStatus = () => {
    if (isArrived) {
      const destination = itinerary.legs[itinerary.legs.length - 1]?.to
      return (
        <section className="planner-simulation__screen planner-simulation__screen--stop" aria-live="assertive">
          <StopIcon size={72} className="planner-simulation__icon planner-simulation__icon--pulse" />
          <p className="eyebrow">TIBA DI TUJUAN</p>
          <h3>Anda tiba di {destination?.name ?? 'tujuan'}</h3>
          <p>Terima kasih telah menggunakan Transense.</p>
        </section>
      )
    }
    if (!leg) return null
    if (leg.mode === 'WALK') {
      return (
        <section className="planner-simulation__screen planner-simulation__screen--search" aria-live="polite">
          <WalkIcon size={64} className="planner-simulation__icon" />
          <p className="eyebrow">JALAN KAKI</p>
          <h3>Berjalan menuju {leg.to.name}</h3>
          <p className="planner-simulation__eta">{userPos ? `${Math.round(haversineM(userPos, { lat: leg.to.lat, lng: leg.to.lng }))} m lagi` : 'Aktifkan lokasi untuk progres.'}</p>
        </section>
      )
    }
    if (leg.mode === 'BUS') {
      return (
        <section className="planner-simulation__screen planner-simulation__screen--search" aria-live={legPhase === 'awaiting' ? 'polite' : 'assertive'}>
          <BusIcon size={64} className="planner-simulation__icon" />
          <p className="eyebrow">{legPhase === 'awaiting' ? 'MENUNGGU BUS' : 'DI DALAM BUS'}</p>
          <h3>
            {legPhase === 'awaiting'
              ? `Bus ${leg.route?.short_name ?? ''} menuju ${leg.headsign ?? leg.to.name}`
              : `Berhenti di ${leg.to.name}`}
          </h3>
          <p className="planner-simulation__eta">
            {legPhase === 'awaiting'
              ? nextArrival
                ? `Bus tiba dalam ${nextArrival.eta_minutes} menit lagi${nextArrival.eta_source === 'estimated' ? ' (perkiraan)' : ''}`
                : arrivalUnavailable
                  ? 'Data bus tidak tersedia. Tunggu di halte.'
                  : 'Mencari armada terdekat…'
              : isApproaching
                ? 'Bersiap turun di halte tujuan.'
                : 'Halte berikutnya: tujuan Anda.'}
          </p>
        </section>
      )
    }
    const nearestTrain = trains[0]
    const railName = leg.route?.short_name ?? 'KERETA'
    return (
      <section className="planner-simulation__screen planner-simulation__screen--search" aria-live={legPhase === 'awaiting' ? 'polite' : 'assertive'}>
        <StopIcon size={64} className="planner-simulation__icon" />
        <p className="eyebrow">{legPhase === 'awaiting' ? `MENUNGGU ${railName}` : `DI DALAM ${railName}`}</p>
        <h3>{legPhase === 'awaiting' ? `${railName} menuju ${leg.headsign ?? leg.to.name}` : `Berhenti di ${leg.to.name}`}</h3>
        <p className="planner-simulation__eta">
          {legPhase === 'awaiting'
            ? nearestTrain
              ? `Kereta terdekat ${nearestTrain.progress_pct}% perjalanan · berikutnya: ${nearestTrain.next_station ?? '—'}`
              : arrivalUnavailable
                ? `Data jadwal ${railName} tidak tersedia. Tunggu di stasiun.`
                : 'Menunggu data jadwal…'
            : isApproaching
              ? 'Bersiap turun di stasiun tujuan.'
              : 'Stasiun berikutnya: tujuan Anda.'}
        </p>
      </section>
    )
  }

  return (
    <main className="page-content inner-page planner-page planner-simulation-page">
      <section className="planner-simulation__header">
        <button type="button" className="schedule-detail__back" onClick={onBack}><ArrowBackIcon size={18} /> Kembali ke rute</button>
        <p className="eyebrow">ANTAR AKU · TRACKING REAL</p>
        <h2>Perjalanan {legIndex + 1}/{itinerary.legs.length}</h2>
      </section>

      {isApproaching || isArrived ? <div className={`edge-flash ${isArrived ? 'edge-flash--safe' : 'edge-flash--danger'}`} aria-hidden="true" /> : null}

      {renderLegStatus()}

      {leg && leg.mode !== 'WALK' && legPhase === 'awaiting' && (
        <button type="button" className="primary-button planner-track-button" onClick={boardLeg}>
          {leg.mode === 'BUS' ? 'Naik bus' : `Naik ${leg.route?.short_name ?? 'kereta'}`} <span aria-hidden="true"><ArrowRightIcon size={20} /></span>
        </button>
      )}
      {leg && leg.mode !== 'WALK' && legPhase === 'awaiting' && boardReady && !gpsUnavailable ? (
        <p className="planner-locate-note" role="status">GPS mendeteksi kamu di {leg.from.name} — naik saat kendaraan tiba.</p>
      ) : null}
      {gpsUnavailable && leg && leg.mode !== 'WALK' ? (
        <p className="planner-locate-error" role="status">Lokasi tidak tersedia — gunakan tombol di atas untuk menandai naik/turun.</p>
      ) : null}

      <section className="planner-map-dropdown" aria-label="Peta perjalanan">
        <MapboxMap stops={mapStops} buses={mapBuses} />
      </section>
    </main>
  )
}
