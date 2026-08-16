import { useEffect, useState } from 'react'

export interface FacilityStopInfo {
  id: string
  name: string
}

export interface OccupancyData {
  occupancy: 'low' | 'moderate' | 'high'
  wheelchair_spots_available: number
  updated_at: string
  source: string
}

interface OccupancyCardProps {
  apiBaseUrl: string
  sendRampRequest: (stopId: string) => void
  lastRampAck: string | null
}

const DEFAULT_STOP_ID = 'fac-bundaran-hi'

const OCCUPANCY_LABELS: Record<OccupancyData['occupancy'], string> = {
  low: 'Renggang',
  moderate: 'Sedang',
  high: 'Padat',
}

const OCCUPANCY_HELP: Record<OccupancyData['occupancy'], string> = {
  low: 'Halte lengang, kursi roda tersedia.',
  moderate: 'Halte cukup ramai, kursi roda terbatas.',
  high: 'Halte padat, kursi roda hampir penuh.',
}

function isOccupancyData(value: unknown): value is OccupancyData {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    (record.occupancy === 'low' || record.occupancy === 'moderate' || record.occupancy === 'high')
    && typeof record.wheelchair_spots_available === 'number'
    && typeof record.updated_at === 'string'
    && !Number.isNaN(Date.parse(record.updated_at))
    && typeof record.source === 'string'
  )
}

export default function OccupancyCard({ apiBaseUrl, sendRampRequest, lastRampAck }: OccupancyCardProps) {
  const [stops, setStops] = useState<FacilityStopInfo[]>([])
  const [selectedStopId, setSelectedStopId] = useState('')
  const [occupancy, setOccupancy] = useState<OccupancyData | null>(null)
  const [detail, setDetail] = useState('Memuat fasilitas halte…')

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/facilities/stops`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json() as { stops?: unknown }
        if (controller.signal.aborted) return
        const loaded = Array.isArray(data.stops)
          ? data.stops.filter((stop): stop is FacilityStopInfo => {
              return typeof stop === 'object' && stop !== null
                && typeof (stop as Record<string, unknown>).id === 'string'
                && typeof (stop as Record<string, unknown>).name === 'string'
            })
          : []
        setStops(loaded)
        if (loaded.length > 0) {
          setSelectedStopId(loaded[0].id)
        } else {
          setSelectedStopId(DEFAULT_STOP_ID)
          setDetail('Daftar halte fasilitas kosong; menampilkan halte bawaan.')
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setStops([])
        setSelectedStopId(DEFAULT_STOP_ID)
        setDetail('Daftar halte fasilitas belum tersedia; menampilkan halte bawaan.')
        console.warn('Transense could not load facility stops.', error)
      })
    return () => controller.abort()
  }, [apiBaseUrl])

  useEffect(() => {
    if (!selectedStopId) return
    const controller = new AbortController()
    setDetail('Memuat tingkat kepadatan halte…')
    fetch(`${apiBaseUrl}/api/facilities/stops/${encodeURIComponent(selectedStopId)}/occupancy`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data: unknown = await response.json()
        if (!controller.signal.aborted) {
          if (isOccupancyData(data)) {
            setOccupancy(data)
            setDetail('')
          } else {
            setOccupancy(null)
            setDetail('Data kepadatan halte tidak dapat dibaca.')
          }
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setOccupancy(null)
        setDetail('Data kepadatan halte belum tersedia saat ini.')
        console.warn('Transense could not load occupancy.', error)
      })
    return () => controller.abort()
  }, [apiBaseUrl, selectedStopId])

  return (
    <section className="occupancy-card" aria-labelledby="occupancy-card-heading">
      <div className="section-heading">
        <p className="eyebrow">KEPADATAN HALTE</p>
        <h2 id="occupancy-card-heading">Ketersediaan kursi roda</h2>
      </div>
      <label className="occupancy-card__label" htmlFor="occupancy-stop-select">Pilih halte</label>
      <select
        id="occupancy-stop-select"
        className="occupancy-card__select"
        value={selectedStopId}
        onChange={(event) => setSelectedStopId(event.target.value)}
        disabled={stops.length === 0}
      >
        {stops.map((stop) => (
          <option key={stop.id} value={stop.id}>{stop.name}</option>
        ))}
      </select>
      {detail ? <p className="occupancy-card__detail">{detail}</p> : null}
      {occupancy ? (
        <div className="occupancy-card__readout">
          <span className={`occupancy-badge occupancy-badge--${occupancy.occupancy}`}>
            {OCCUPANCY_LABELS[occupancy.occupancy]}
          </span>
          <p className="occupancy-card__spots">
            Kursi roda tersedia: <strong>{occupancy.wheelchair_spots_available}</strong>
          </p>
          <p className="occupancy-card__help">{OCCUPANCY_HELP[occupancy.occupancy]}</p>
          <small className="occupancy-card__updated">
            Terakhir diperbarui {new Date(occupancy.updated_at).toLocaleTimeString('id-ID')}
          </small>
        </div>
      ) : null}
      <button
        className="primary-button occupancy-card__ramp-button"
        type="button"
        onClick={() => sendRampRequest(selectedStopId)}
        disabled={!selectedStopId}
      >
        Minta petugas siapkan ramp
      </button>
      {lastRampAck ? (
        <p className="occupancy-card__ack" role="status">{lastRampAck}</p>
      ) : null}
    </section>
  )
}
